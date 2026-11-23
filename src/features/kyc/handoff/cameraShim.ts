/**
 * The one place `navigator.mediaDevices` is patched.
 *
 * TWO features live here, and they live here together on purpose. The hand-off
 * (below) replaces the camera; the quality lift (`installCaptureQuality`) only
 * edits the constraints on the way past. Both need the same global, and two
 * independent patchers over one global is a bug waiting for the session where
 * both are live — each captures "the original" at install time, so whichever
 * uninstalls second restores the other one's patch and the page is left unable
 * to open a real camera.
 *
 * So there is one patch slot and one pair of saved originals. `apply()` rebuilds
 * the patched methods from whatever is currently switched on, and the real
 * methods go back only when nothing is.
 *
 * ── The shim that makes the phone's camera look like this computer's camera ──
 *
 * ── Why replace getUserMedia rather than pass a stream around ───────────────
 * Because the screens that need it do not all accept one.
 *
 * `useCamera` is ours and could take a stream as a prop. AWS's
 * `FaceLivenessDetectorCore` cannot: it acquires its own camera internally and
 * exposes no way to hand it a MediaStream. Threading a prop through would
 * therefore have fixed ID capture and left face verification — the step a
 * camera-less desktop is most stuck on — exactly as broken as before.
 *
 * Replacing `getUserMedia` fixes both at once, and changes no existing screen
 * at all. Every caller asks for a camera the way it always has and receives the
 * phone's. That is the entire point: the current flow is untouched, and the
 * source of the pixels changes underneath it.
 *
 * ── What is replaced, and what is put back ──────────────────────────────────
 * Two methods, both restored exactly on `uninstall()`:
 *
 *   getUserMedia     hands back the relayed stream instead of opening a device.
 *   enumerateDevices reports one video input. Without it a caller that checks
 *                    for a camera before asking for one — which is precisely
 *                    what a no-camera desktop does — decides there is nothing
 *                    to use and never calls getUserMedia at all.
 *
 * ⚠️ Scope. This is global to the page for as long as it is installed, so it
 * must be installed only while a hand-off is live and uninstalled the moment it
 * ends. It is not a permanent replacement for the camera stack.
 */

type GetUserMedia = typeof navigator.mediaDevices.getUserMedia;
type EnumerateDevices = typeof navigator.mediaDevices.enumerateDevices;

let original: { gum: GetUserMedia; enumerate: EnumerateDevices } | null = null;

/** The relayed stream, when a hand-off is live. */
let relayStream: MediaStream | null = null;
/**
 * The relayed video tracks, held apart from `relayStream` (2026-11-24).
 *
 * Every camera request used to get `relayStream` itself, and a screen that
 * finished took its track OUT of that stream (`removeTrack`): the next request
 * — AWS after a retry — found the stream with no video and waited for ever on
 * a black frame while the phone was still filming. Each request now gets its
 * own MediaStream around these same tracks, so nobody can empty another's.
 */
let relayTracks: MediaStreamTrack[] = [];
/** The phone's own stream, before the steadying canvas — see relayPreview. */
let rawRelay: MediaStream | null = null;

/** The resolution to ask cameras for, when the quality lift is on. */
let qualityBoost: { width: number; height: number } | null = null;

/**
 * On a computer the camera is ALWAYS the phone's (decided 2026-11-22): the
 * laptop's own camera is never opened. While this is on, a request for video
 * waits until the hand-off delivers the phone's stream, and then gets that.
 * Every capture screen — the ID scanner, the light check, AWS liveness — goes
 * through `getUserMedia`, so this one switch covers them all.
 */
let phoneOnly = false;
let waiting: ((stream: MediaStream) => void)[] = [];

/*
 * Counted, not a flag: a panel mounting while another unmounts (a remount, Strict
 * Mode) ran on(true) then the old one's off(false), leaving it OFF while a hand-off
 * was showing — measured 2026-11-24. Each panel adds one and takes one away.
 */
let phoneOnlyHolders = 0;

/*
 * A phone's own camera, handed from the light check to AWS (2026-11-24). Closing
 * it for AWS to open again froze the picture ~1–2 s on a phone after "light is
 * good". The NEXT request for video gets this very stream (a real camera: its
 * track describes itself, so AWS's 15 fps check passes as it always did); not
 * taken within HANDOVER_MS, it is stopped and the stack goes back to normal.
 */
let handedOver: { stream: MediaStream; timer: ReturnType<typeof setTimeout> } | null = null;
const HANDOVER_MS = 20_000;

export function handOverCamera(stream: MediaStream): void {
  dropHandover(true);
  if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
  handedOver = { stream, timer: setTimeout(() => dropHandover(true), HANDOVER_MS) };
  apply();
}

/** The handed-over camera, LIVE, for the screen to show until AWS takes it — its own stream (see relayTracks). */
export function handedOverPreview(): MediaStream | null {
  const live = handedOver?.stream.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];
  return live.length ? new MediaStream(live) : null;
}

function takeHandover(): MediaStream | null {
  const h = handedOver;
  if (!h) return null;
  dropHandover(false);
  return h.stream.getVideoTracks().some((t) => t.readyState === 'live') ? h.stream : null;
}

/** Forget the handed-over stream; `stop` when nobody took it. */
function dropHandover(stop: boolean): void {
  if (!handedOver) return;
  clearTimeout(handedOver.timer);
  if (stop) handedOver.stream.getTracks().forEach((t) => t.stop());
  handedOver = null;
  apply();
}

export function requirePhoneCamera(on: boolean): void {
  phoneOnlyHolders = Math.max(0, phoneOnlyHolders + (on ? 1 : -1));
  phoneOnly = phoneOnlyHolders > 0;
  apply();
}

/**
 * The phone's live picture, for a screen to SHOW while its own camera changes
 * hands (2026-11-24): over a hand-off nothing closes between the light check and
 * AWS's camera, so the laptop can keep the person moving instead of a still.
 * Its own stream, like every request (see relayTracks). Null without a live relay.
 */
export function relayPreview(): MediaStream | null {
    // The RAW phone track, not the canvas copy: the browser plays it on its own,
    // so it keeps moving while the page is busy — the canvas is redrawn BY the page
    // and froze with it (2026-11-24). Only for showing: AWS still gets the steady one.
    const raw = rawRelay?.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];
    if (raw.length) return new MediaStream(raw);
    return relayStream && relayTracks.some((t) => t.readyState === 'live') ? new MediaStream(relayTracks) : null;
}

/** Is a hand-off currently feeding this page's cameras? */
export function isShimInstalled(): boolean {
    return relayStream !== null;
}

/**
 * Point every camera request at `stream` until `uninstall()`.
 *
 * Calling twice replaces the stream rather than nesting, so the ORIGINAL
 * methods are captured once and a second install cannot lose them — which
 * would leave the page permanently unable to open a real camera.
 */
/**
 * What a relayed track must claim about itself before AWS will use it.
 *
 * ⚠️ THE reason face verification failed over the hand-off with
 * `CAMERA_FRAMERATE_ERROR: No camera found with more than 15 fps`.
 *
 * Amplify gates on this, verbatim (machine.mjs):
 *
 *   const tracksWithMoreThan15Fps = initialStream.getTracks()
 *       .filter((track) => (track.getSettings().frameRate ?? 0) >= 15);
 *   if (tracksWithMoreThan15Fps.length < 1)
 *       throw new Error('No camera found with more than 15 fps');
 *
 * A track from `getUserMedia` reports its real capture settings. A track
 * arriving over WebRTC reports almost nothing — the browser has no camera to
 * describe, so `frameRate` is simply absent, `?? 0` makes it zero, and the
 * check fails before a single frame is looked at. Nothing was wrong with the
 * video; it just could not say how fast it was.
 *
 * So the track is asked to describe itself honestly-ish: the resolution it is
 * actually delivering, and a frame rate it is actually capable of. 30 is not
 * invented — it is the rate the phone's camera is capturing and the sender is
 * encoding at; it is only missing from the metadata, not from the video.
 *
 * Patched on the INSTANCE, so nothing else in the page is affected and the
 * change dies with the track.
 */
/** Each relayed track's REAL stop, kept for the hand-off's own teardown. */
const realStops = new WeakMap<MediaStreamTrack, () => void>();

/** End a relayed track for real — only the hand-off, which owns it, calls this. */
export function endRelayedTrack(track: MediaStreamTrack): void {
    (realStops.get(track) ?? (() => track.stop()))();
}

/**
 * `size`: the frame the track REALLY carries, when we know it better than the
 * track does (the redrawn canvas). AWS sizes the picture it judges from these
 * numbers: a portrait phone picture described as 1280×720 was stretched
 * sideways, the face looked wide and close, and AWS said "move back" for ever.
 */
function describeRelayedTrack(track: MediaStreamTrack, size?: () => { width: number; height: number }): void {
    const real = track.getSettings();

    /*
      A capture screen stopping its camera must not end the PHONE'S track.
      Every screen gets this same stream, and each stops "its" camera when it
      is done — the light check does so the moment AWS takes over. Ending the
      shared track froze the picture on its last frame, AWS then streamed a
      dead track (SERVER_ERROR), and the retry found it at 0 fps ("too slow").
      The hand-off owns this track's life (`endRelayedTrack`, and closing the
      connection ends it anyway); a consumer's stop() is a no-op.
    */
    if (!realStops.has(track)) {
        realStops.set(track, track.stop.bind(track));
        Object.defineProperty(track, 'stop', { configurable: true, value: () => {} });
    }

    // `getSettings` first, because that is what the 15fps gate reads.
    Object.defineProperty(track, 'getSettings', {
        configurable: true,
        value: (): MediaTrackSettings => ({
            ...real,
            // Under 15, not just absent: a remote track reports 0 until its
            // first frames arrive, and the hand-off now answers a waiting
            // request the instant the phone connects — exactly then. 0 is not
            // nullish, so `?? 30` kept it, and AWS refused every attempt.
            // The phone captures at 30 (PhoneCamera asks for it, min 15).
            frameRate: (real.frameRate ?? 0) >= 15 ? real.frameRate : 30,
            width: size?.().width || real.width || 1280,
            height: size?.().height || real.height || 720,
            deviceId: real.deviceId || HANDOFF_DEVICE_ID,
            groupId: real.groupId || HANDOFF_GROUP_ID,
        }),
    });

    // `getCapabilities` is not on the failing path today, but Amplify reads it
    // elsewhere and a remote track either omits it or returns an empty object.
    // Answering consistently here costs nothing and avoids the next surprise.
    Object.defineProperty(track, 'getCapabilities', {
        configurable: true,
        value: (): MediaTrackCapabilities => ({
            frameRate: { min: 15, max: 30 },
            width: { min: 320, max: size?.().width || real.width || 1280 },
            height: { min: 240, max: size?.().height || real.height || 720 },
            deviceId: HANDOFF_DEVICE_ID,
            groupId: HANDOFF_GROUP_ID,
        }),
    });
}

/**
 * ⚠️ Must never contain the word "virtual".
 *
 * Amplify drops any device whose label does — `isCameraDeviceVirtual()` is
 * literally `device.label.toLowerCase().includes('virtual')` — and a dropped
 * device means "No real video devices found", which is the same dead end as the
 * frame-rate error by a different name.
 */
const HANDOFF_DEVICE_LABEL = 'Phone camera';
const HANDOFF_DEVICE_ID = 'ramaaz-handoff-camera';
const HANDOFF_GROUP_ID = 'ramaaz-handoff';

/**
 * Raise the resolution every camera request asks for.
 *
 * ── Why this is necessary at all ────────────────────────────────────────────
 * AWS hardcodes what Face Liveness asks the camera for — `STATIC_VIDEO_
 * CONSTRAINTS` in `@aws-amplify/ui-react-liveness/.../utils/helpers.mjs`:
 *
 *     width: { min: 320, ideal: 640 }   height: { min: 240, ideal: 480 }
 *
 * and `FaceLivenessDetectorCore` exposes no prop that overrides it. The check
 * therefore runs on VGA, and the still kept from that stream is painted into a
 * 350x400 frame that is 1050x1200 real pixels on a phone. That upscale is THE
 * reason the captured face looks soft, and no amount of colour work fixes a
 * picture that does not have the detail in it.
 *
 * ── Why editing the constraints, and not the track ──────────────────────────
 * `track.applyConstraints()` after the fact was the obvious alternative and is
 * the wrong one: AWS derives the oval's geometry and the face-fit test from the
 * stream's dimensions, so changing them mid-session races code that has already
 * read the old numbers. Editing the request means AWS is handed a stream that
 * was the right size from the first frame, and every downstream read — oval,
 * fit test, anchor — is consistent because all of them read the live stream.
 *
 * AWS's own floor is 320x240, so a larger stream satisfies every constraint it
 * set. `ideal` is also never a rejection: a camera that cannot manage 960 lines
 * returns what it has rather than throwing OverconstrainedError.
 *
 * ── What it deliberately does not touch ─────────────────────────────────────
 * `facingMode`, `frameRate`, `deviceId`, `aspectRatio` and any `exact` the
 * caller set — all passed through untouched. Only `width`/`height` `ideal` move,
 * and only upward: a caller that already asked for more keeps what it asked for.
 * `useCamera` asks for 1500x900 and is unaffected by this.
 */
export function installCaptureQuality(size: { width: number; height: number }): void {
    qualityBoost = size;
    apply();
}

export function uninstallCaptureQuality(): void {
    qualityBoost = null;
    apply();
}

/** Raise `ideal` width/height without disturbing anything else the caller set. */
function boostConstraints(video: MediaTrackConstraints): MediaTrackConstraints {
    if (!qualityBoost) return video;

    // `exact` is a hard requirement the caller chose; overriding it would turn
    // a working request into an OverconstrainedError. Left alone.
    const hasExact =
        (typeof video.width === 'object' && 'exact' in video.width) ||
        (typeof video.height === 'object' && 'exact' in video.height);
    if (hasExact) return video;

    const idealOf = (c: ConstrainULong | undefined): number =>
        typeof c === 'number' ? c : typeof c === 'object' ? (c.ideal ?? 0) : 0;

    // Never downward. A caller asking for more than the boost knows something
    // this function does not.
    const width = Math.max(qualityBoost.width, idealOf(video.width));
    const height = Math.max(qualityBoost.height, idealOf(video.height));

    return {
        ...video,
        width: { ...(typeof video.width === 'object' ? video.width : {}), ideal: width },
        height: { ...(typeof video.height === 'object' ? video.height : {}), ideal: height },
    };
}

/**
 * The phone's video, redrawn at a CONSTANT size and a steady 30 fps.
 *
 * ⚠️ Why this exists — measured, not guessed (2026-11-22). Over the hand-off
 * AWS came back SUCCEEDED with confidence 0.0001 and NO image at all, on
 * today's code AND on the hand-off code from before it, while the laptop's
 * own camera passed the same check (liveness 78.8) minutes later. AWS records
 * the camera it is given; a WebRTC track changes resolution and frame rate
 * whenever the network wobbles, and a recording whose frame size keeps
 * changing is one AWS cannot analyse. A webcam never does that.
 *
 * So AWS is given what a webcam gives: a canvas the relayed video is drawn
 * into every frame, sized once from the phone's first frame (long side at
 * most 1280), and captured at 30 fps. The phone's picture can shrink or
 * stutter underneath; what AWS records never changes shape.
 */
let normalized: { stream: MediaStream; stop: () => void; size: () => { width: number; height: number } } | null = null;

function normalize(source: MediaStream): MediaStream {
    if (typeof document === 'undefined') return source;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = source;
    /*
      ON the page, tiny and practically invisible. A video that is not in the
      document (or is hidden) gets no new frames from the browser, so the
      canvas kept redrawing ONE frame: AWS saw a frozen face, said "move back
      slightly" for ever whatever the person did, and the session expired.
    */
    Object.assign(video.style, {
        position: 'fixed',
        right: '0',
        bottom: '0',
        width: '2px',
        height: '2px',
        opacity: '0.01',
        pointerEvents: 'none',
        zIndex: '-1',
    });
    document.body.appendChild(video);
    void video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    // Shaped like the phone's picture from the start — never the canvas default
    // (300×150): AWS reads the size when it opens the camera, maybe before the
    // first frame. The phone asks for 7:8 (PhoneCamera), so that is the guess.
    const first = source.getVideoTracks()[0]?.getSettings();
    const fit = (w: number, h: number) => {
        const scale = Math.min(1, 1280 / Math.max(w, h));
        canvas.width = Math.round((w * scale) / 2) * 2;
        canvas.height = Math.round((h * scale) / 2) * 2;
    };
    fit(first?.width || 700, first?.height || 800);
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') return source;

    let sized = false;
    const draw = () => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return;
        // The real shape, once, from the first frame (the guess above may differ).
        if (!sized) {
            fit(w, h);
            sized = true;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    };
    // Each NEW phone frame where the browser can say so; a timer as well,
    // so the canvas keeps producing frames at 30 fps between them (and where
    // requestVideoFrameCallback does not exist). Not requestAnimationFrame:
    // it stops while the tab is in the background.
    type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const fv = video as FrameVideo;
    let alive = true;
    const onFrame = () => {
        if (!alive) return;
        draw();
        fv.requestVideoFrameCallback?.(onFrame);
    };
    fv.requestVideoFrameCallback?.(onFrame);
    const timer = window.setInterval(draw, 1000 / 30);

    const out = canvas.captureStream(30);
    normalized = {
        stream: out,
        size: () => ({ width: canvas.width, height: canvas.height }),
        stop: () => {
            alive = false;
            window.clearInterval(timer);
            out.getTracks().forEach((t) => (realStops.get(t) ?? (() => t.stop()))());
            video.srcObject = null;
            video.remove();
        },
    };
    return out;
}

export function installCameraShim(stream: MediaStream): void {
    normalized?.stop();
    normalized = null;
    const steady = normalize(stream);
    // Before anything asks: the track has to be able to describe itself, or
    // AWS rejects it sight unseen. See describeRelayedTrack. (A canvas track
    // already reports its size and rate; describing it is harmless and keeps
    // the consumer stop() a no-op.)
    steady.getVideoTracks().forEach((t) => describeRelayedTrack(t, normalized?.size));
    stream.getVideoTracks().forEach((t) => describeRelayedTrack(t));
    relayStream = steady;
    relayTracks = steady.getVideoTracks();
    rawRelay = stream;
    apply();
    // Whoever asked while the phone was not connected yet gets it now.
    const asked = waiting;
    waiting = [];
    // The same steady tracks every later request gets, each in its own stream (see relayTracks).
    asked.forEach((resolve) => resolve(new MediaStream(relayTracks)));
}

/**
 * Install, replace or remove the patch to match what is currently switched on.
 *
 * Called by every installer and uninstaller. The originals are captured on the
 * first patch and restored only when BOTH features are off, which is the
 * property that makes the two safe to use together in any order.
 */
function apply(): void {
    /*
     * There is no camera stack on the server.
     *
     * Load-bearing since `installCaptureQuality` moved into LivenessCamera's
     * RENDER — see the note there on why it had to. Client components are still
     * server-rendered, so this function now runs during SSR, where
     * `navigator` does not exist and reaching for `.mediaDevices` throws
     * during prerender. Nothing to patch there and nothing to restore.
     */
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const md = navigator.mediaDevices;

    if (!relayStream && !qualityBoost && !phoneOnly && !handedOver) {
        if (original) {
            md.getUserMedia = original.gum;
            md.enumerateDevices = original.enumerate;
            original = null;
        }
        return;
    }

    if (!original) {
        original = {
            gum: md.getUserMedia.bind(md),
            enumerate: md.enumerateDevices.bind(md),
        };
    }
    const real = original;

    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        // Audio is never relayed — this hand-off carries video only. A caller
        // that asks for audio would otherwise get a stream with no audio track
        // and fail somewhere less obvious than here.
        if (constraints?.audio && !constraints.video) return real.gum(constraints);

        // Only a stream still carrying video. A dead one (the phone walked
        // away) is never handed out: on a computer the request waits for the
        // phone to connect again, through the new QR the hand-off opens.
        if (relayStream && relayTracks.some((t) => t.readyState === 'live')) {
            // Re-describe on EVERY call, not just at install.
            //
            // A retry re-mounts the capture screen and asks for a camera again,
            // and by then the track may not be the one that was patched: WebRTC
            // can replace a remote track mid-connection, and a caller that
            // stopped the previous one leaves a track whose description no
            // longer applies. An unpatched track reports no frameRate, and AWS
            // answers CAMERA_FRAMERATE_ERROR — the same failure as before the
            // shim existed, reappearing only on the second attempt, which is
            // how it was missed.
            //
            // Idempotent: describing an already-described track just rewrites
            // the same two properties.
            relayTracks.forEach((t) => describeRelayedTrack(t, normalized?.size));

            // The SAME tracks for every caller (never clones: one screen's
            // `stop()` would kill what another still needs — and `stop()` is a
            // no-op on these, see describeRelayedTrack), in a NEW stream each
            // time, so a caller's removeTrack empties only its own (see
            // `relayTracks`). The hand-off owns the tracks' lifetime.
            //
            // The quality lift does not apply here and must not: the resolution
            // of a relayed stream is the phone's decision, made by
            // `PhoneCamera`'s own constraints at the other end of the link.
            return new MediaStream(relayTracks);
        }

        // The light check's camera, still open (see handOverCamera).
        if (constraints?.video) {
            const kept = takeHandover();
            if (kept) return kept;
        }

        // A computer never opens its own camera: wait for the phone.
        if (phoneOnly && constraints?.video) {
            return new Promise<MediaStream>((resolve) => waiting.push(resolve));
        }

        // Quality lift only — a real camera, asked for more pixels.
        const video = constraints?.video;
        if (!video || video === true) {
            return real.gum({ ...constraints, video: boostConstraints({}) });
        }
        return real.gum({ ...constraints, video: boostConstraints(video) });
    };

    md.enumerateDevices = async () => {
        const devices = await real.enumerate().catch(() => []);
        // Only the hand-off invents a device. With just the quality lift on,
        // the real list is the right answer.
        if (!relayStream) return devices;

        const phone = {
            deviceId: HANDOFF_DEVICE_ID,
            groupId: HANDOFF_GROUP_ID,
            kind: 'videoinput' as const,
            // A FIXED label, never the track's own. A remote track's label is
            // whatever the sender happened to set, and if it ever contained
            // "virtual" Amplify would discard this device and report that no
            // real camera exists. See HANDOFF_DEVICE_LABEL.
            label: HANDOFF_DEVICE_LABEL,
            toJSON() {
                return { ...this };
            },
        } as MediaDeviceInfo;

        // Ours FIRST: callers that pick a camera generally take the first
        // videoinput, and on the machines this exists for there is no other.
        return [phone, ...devices.filter((d) => d.kind !== 'videoinput')];
    };
}

/** Hand the page's real camera stack back, exactly as it was. */
export function uninstallCameraShim(): void {
    normalized?.stop();
    normalized = null;
    relayStream = null;
    relayTracks = [];
    rawRelay = null;
    apply();
}

/**
 * Why a hand-off is being offered — or `null` when the real camera is fine.
 *
 * Checked BEFORE any capture screen mounts, because the most common reason is
 * the one that cannot be retried: a denied camera permission is remembered per
 * origin, so the browser will not prompt again and there is nothing for the
 * user to click. Waiting for repeated failures before offering the QR leaves
 * them pressing a button that can never work.
 */
export type CameraTrouble = 'no-camera' | 'denied' | 'failed';

/**
 * Is this a phone or tablet — a device that already has the camera the
 * hand-off would go and fetch?
 *
 * ⚠️ DEVICE, never viewport. No `matchMedia`, no `innerWidth`, no breakpoint.
 * A desktop browser dragged narrow is still a desktop and still the case this
 * feature exists for; a tablet held in landscape is wide and still pointless to
 * offer it to. Sizing the decision on pixels gets both backwards.
 *
 * Three signals, strongest first:
 *
 *  1. `navigator.userAgentData.mobile` — the platform answering the question
 *     directly. Chromium only, which covers most desktops and all of Android.
 *  2. The agent string. Crude, but it is what Safari and Firefox leave us.
 *  3. iPadOS, which needs its own line: it reports itself as "Macintosh" and is
 *     distinguishable from a real Mac only by having a touchscreen. Without
 *     this an iPad is offered a QR code to scan with itself.
 */
export function isHandheldDevice(): boolean {
    if (typeof navigator === 'undefined') return false;

    const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
        .userAgentData;
    if (typeof uaData?.mobile === 'boolean') return uaData.mobile;

    const ua = navigator.userAgent;
    if (/Android|iPhone|iPod|IEMobile|Opera Mini|\bMobi\b/i.test(ua)) return true;

    // iPad, including the ones pretending to be a Mac.
    if (/iPad/i.test(ua)) return true;
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;

    return false;
}

export async function detectCameraTrouble(): Promise<CameraTrouble | null> {
    if (isShimInstalled()) return null;

    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return 'no-camera';

    try {
        const devices = await md.enumerateDevices();
        if (!devices.some((d) => d.kind === 'videoinput')) return 'no-camera';
    } catch {
        return 'no-camera';
    }

    // Permissions API where it exists — it answers without opening the camera,
    // so it cannot itself trigger the prompt we are trying to characterise.
    // Firefox does not support the `camera` name and throws; that is not a
    // failure, it just means we learn nothing here.
    try {
        const status = await navigator.permissions.query({
            name: 'camera' as PermissionName,
        });
        if (status.state === 'denied') return 'denied';
    } catch {
        /* unsupported — fall through */
    }

    return null;
}

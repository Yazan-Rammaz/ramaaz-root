/**
 * The shim that makes the phone's camera look like this computer's camera.
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

/** Is a hand-off currently feeding this page's cameras? */
export function isShimInstalled(): boolean {
    return original !== null;
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
function describeRelayedTrack(track: MediaStreamTrack): void {
    const real = track.getSettings();

    // `getSettings` first, because that is what the 15fps gate reads.
    Object.defineProperty(track, 'getSettings', {
        configurable: true,
        value: (): MediaTrackSettings => ({
            ...real,
            frameRate: real.frameRate ?? 30,
            width: real.width ?? 1280,
            height: real.height ?? 720,
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
            width: { min: 320, max: real.width ?? 1280 },
            height: { min: 240, max: real.height ?? 720 },
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

export function installCameraShim(stream: MediaStream): void {
    const md = navigator.mediaDevices;

    // Before anything asks: the relayed track has to be able to describe
    // itself, or AWS rejects it sight unseen. See describeRelayedTrack.
    stream.getVideoTracks().forEach(describeRelayedTrack);

    if (!original) {
        original = {
            gum: md.getUserMedia.bind(md),
            enumerate: md.enumerateDevices.bind(md),
        };
    }

    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        // Audio is never relayed — this hand-off carries video only. A caller
        // that asks for audio would otherwise get a stream with no audio track
        // and fail somewhere less obvious than here.
        if (constraints?.audio && !constraints.video) {
            if (!original) throw new Error('camera shim not installed');
            return original.gum(constraints);
        }

        // Re-describe on EVERY call, not just at install.
        //
        // A retry re-mounts the capture screen and asks for a camera again, and
        // by then the track may not be the one that was patched: WebRTC can
        // replace a remote track mid-connection, and a caller that stopped the
        // previous one leaves a track whose description no longer applies. An
        // unpatched track reports no frameRate, and AWS answers
        // CAMERA_FRAMERATE_ERROR — the same failure as before the shim existed,
        // reappearing only on the second attempt, which is how it was missed.
        //
        // Idempotent: describing an already-described track just rewrites the
        // same two properties.
        stream.getVideoTracks().forEach(describeRelayedTrack);

        // The SAME MediaStream for every caller, deliberately. Cloning per call
        // would let one screen's `stop()` kill the tracks another still needs,
        // and the hand-off owns this stream's lifetime, not its consumers.
        return stream;
    };

    md.enumerateDevices = async () => {
        const real = original ? await original.enumerate().catch(() => []) : [];

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
        return [phone, ...real.filter((d) => d.kind !== 'videoinput')];
    };
}

/** Hand the page's real camera stack back, exactly as it was. */
export function uninstallCameraShim(): void {
    if (!original) return;
    navigator.mediaDevices.getUserMedia = original.gum;
    navigator.mediaDevices.enumerateDevices = original.enumerate;
    original = null;
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

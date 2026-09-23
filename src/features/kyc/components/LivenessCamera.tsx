'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

import { TFJS_WASM_PATH, blazefaceModelUrl } from '@/features/kyc/config/liveness';
import {
    CAPTURE_LIVE_GLASS,
    CAPTURE_MIRROR,
    CAPTURE_PORTRAIT,
    CAPTURE_RESOLUTION,
} from '@/features/kyc/config/capture';
import { GlassFilter } from '@/features/kyc/components/GlassFilter';
import { useLivePreview } from '@/features/kyc/hooks/useLivePreview';
import { scoreFrameQuality } from '@/features/kyc/services/imageQuality';
import {
    frameHasContent,
    grabFrame,
    processFrame,
    type FaceCapture,
} from '@/features/kyc/services/faceCapture';
import { kickstartSegmenter, segmentToMask } from '@/features/kyc/services/portrait';
import { measureSkin } from '@/features/kyc/services/skinMask';
import {
    installCaptureQuality,
    uninstallCaptureQuality,
} from '@/features/kyc/handoff/cameraShim';
import './liveness.css';

/**
 * How often the camera is sampled for a keepable still.
 *
 * Five a second rather than the two-and-a-half it was: the selection below can
 * only be as good as the candidates it sees, and a blink or a turn is over in
 * well under 400ms. The cost per tick is a `drawImage` onto a 96px canvas and
 * one Sobel pass over it.
 */
const FRAME_POLL_MS = 200;

/**
 * How long the held frame keeps its slot without being beaten.
 *
 * Without this, one sharp frame early on wins for the rest of the session — and
 * early frames are the worst ones to keep, taken while the user is still
 * settling and lit by whatever the screen was showing before the check. After
 * this long the holder is replaced by the next frame regardless of score, so
 * the still stays roughly current.
 */
const BEST_FRAME_WINDOW_MS = 2000;

/**
 * How often the live glass re-measures where the face is.
 *
 * Slower than the frame poll on purpose: this runs while the device is encoding
 * and uploading video for the liveness check, which AWS fails below 15fps, and
 * a head does not travel far in a third of a second. The CSS eases between
 * measurements, so a slow clock reads as smooth rather than steppy.
 */
const FACE_TRACK_MS = 320;

/**
 * The live pane's refraction filter id — its own, never the checking pane's.
 *
 * Module scope rather than a prop: only one liveness widget is ever mounted, and
 * an id generated per render would change on every re-render, leaving the CSS
 * `url()` pointing at a filter that no longer exists — which silently drops the
 * whole `filter` declaration, blur included.
 */
const LIVE_GLASS_FILTER_ID = 'rz-live-glass-warp';

/**
 * Draw the video into `target`, cropped exactly as the frame displays it.
 *
 * ⚠️ THE CROP IS THE POINT, and getting it wrong is a silent misalignment.
 *
 * The frame is 350x400 and the camera streams 4:3, so `object-fit: cover`
 * throws away a third of the width before anything reaches the screen. Anything
 * measured from the WHOLE sensor frame is therefore in a different coordinate
 * system from the frame it is used to position something in — a face 40% across
 * the stream is not 40% across the frame, and a mask built from the full frame
 * lands stretched over a cropped picture.
 *
 * That mismatch was already present in the face track: the clear hole has been
 * placed from full-frame coordinates onto a cropped picture, which is part of
 * why it never sat quite on anybody. One cropped probe fixes both users of it
 * and costs one `drawImage` rather than two.
 *
 * Returns false when the video has no frame yet.
 */
function drawProbe(
    target: HTMLCanvasElement,
    video: HTMLVideoElement,
    width: number,
    frameAspect: number,
): boolean {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;

    const height = Math.max(1, Math.round(width / frameAspect));
    if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
    }
    const ctx = target.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;

    // The source rectangle `object-fit: cover` would keep: whichever dimension
    // overflows is trimmed equally from both sides.
    const streamAspect = vw / vh;
    let sw = vw;
    let sh = vh;
    if (streamAspect > frameAspect) {
        sw = vh * frameAspect;
    } else {
        sh = vw / frameAspect;
    }
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
    return true;
}

/**
 * Amazon's Face Liveness widget, in our frame and our language.
 *
 * ── Why this is one component and not two ───────────────────────────────────
 * The sign-in screen and the design gallery's bench run the same check and must
 * keep looking the same; when the theme, the strings and the two vendored model
 * paths were duplicated across both, they had already drifted before anything
 * was pushed. Both now mount this.
 *
 * ── What is ours and what is theirs ─────────────────────────────────────────
 * Ours: the frame, the colours, the type, the hint pill, the Rec badge, the
 * cancel control, the match bar and every string. Theirs: the camera surface
 * and the oval.
 *
 * The oval stays theirs deliberately. It is drawn from the video stream's own
 * geometry and the face-fit test uses the same numbers, so restyling it would
 * leave the guide describing something other than the test being run. See
 * liveness.css, which explains the one thing that IS done to that box.
 */

/** Colours the Amplify primitives; the widget's own chrome is in liveness.css. */
const livenessTheme = createTheme({
    name: 'root-liveness',
    tokens: {
        colors: {
            /*
             * Reaches the Amplify primitives only. It also feeds the oval
             * canvas's surround fill on the START-SCREEN path — which never
             * runs here, because `disableStartScreen` is set below. The path
             * that does run hardcodes `#fff` and ignores this entirely.
             */
            background: { primary: { value: '#000000' } },
            font: { primary: { value: '#FFFFFF' }, inverse: { value: '#FFFFFF' } },
            /*
             * `border.secondary` is deliberately NOT set. AWS strokes the
             * oval with it, and the oval canvas is hidden outright (see
             * liveness.css) — so it would decide nothing. It is the lever to
             * reach for if the ring is ever wanted back; that rule says how.
             */
            brand: {
                primary: {
                    // The action blue, so nothing renders in AWS orange.
                    10: { value: '#EAF1FC' },
                    80: { value: '#3066CC' },
                    90: { value: '#2856AE' },
                    100: { value: '#1F4693' },
                },
            },
        },
        components: {
            button: { primary: { backgroundColor: { value: '#3066CC' } } },
        },
    },
});

type Credentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration?: Date;
};

export function LivenessCamera({
    sessionId,
    region,
    credentialProvider,
    onAnalysisComplete,
    onStreamEnded,
    onCameraLive,
    onFaceMetrics,
    onError,
}: {
    sessionId: string;
    region: string;
    /** Called whenever the AWS SDK needs to sign. */
    credentialProvider: () => Promise<Credentials>;
    /**
     * The stream finished. It does NOT mean the person was live — ask the
     * server.
     *
     * The still kept from the stream, already through the look pipeline
     * (`services/faceCapture.ts`) — `stored` for the backend, `display` for the
     * screen. It is purely presentational as far as the VERDICT goes: AWS picks
     * the image it actually judges from the stream, server-side, and the
     * browser never sees that one. Null if no frame could be grabbed.
     */
    onAnalysisComplete: (capture: FaceCapture | null) => Promise<void>;
    /**
     * The CAMERA stopped — fired the moment the video goes away, not when the
     * analysis returns.
     *
     * ── The gap this exists to close ────────────────────────────────────────
     * `onAnalysisComplete` fires after AWS has uploaded the recording AND
     * processed it, which is five to ten seconds. For all of that time the SDK
     * shows its own dark verifying screen, and the caller — which has a frozen
     * face and a whole checking state ready to go — is still sitting in
     * `streaming` with nothing on screen. It looks like the app hung, and then
     * our checking state flashes past in half a second at the end of it.
     *
     * The camera is visibly gone the instant recording stops, so that is the
     * honest moment to take the frame over. Fires exactly once per mount.
     *
     * ⚠️ IT CARRIES THE CAPTURE, and that is the point of it. Moving the screen
     * on without the photograph produced the exact bug this was meant to fix:
     * the checking state arrived five seconds early and spent them rendering
     * over BLACK, because the still was still being set by
     * `onAnalysisComplete` at the end. The frame exists long before the
     * analysis does — it was picked from the stream while it ran — so it is
     * handed over here.
     *
     * The same object is reused by `onAnalysisComplete` rather than processed
     * twice; see `producedRef`.
     *
     * Optional: a caller that does not distinguish the two states can ignore it
     * and behave as before.
     */
    onStreamEnded?: (capture: FaceCapture | null) => void;
    /**
     * The camera is now showing a picture — fired once, on the first frame with
     * real dimensions.
     *
     * Exists so the caller can take its standby mark DOWN at the right moment.
     * AWS's own "getting the camera ready" screen is hidden (liveness.css), so
     * something of ours has to cover that window, and the only honest end to it
     * is the video actually arriving. Guessing with a timer would either blank
     * the frame early or leave a mark sitting on top of a live camera.
     */
    onCameraLive?: () => void;
    /**
     * How large the face is in frame, as a fraction of the frame's width,
     * measured a few times a second.
     *
     * A distance proxy, and the only one available here: AWS does not surface
     * its own detection, and the oval it measures against is not something we
     * can read. `measureSkin` is already running for the live glass's clear
     * hole, so this costs nothing extra — it reports what was measured anyway.
     *
     * The caller uses it to size the standby mark, which is how somebody knows
     * they are moving the right way before AWS says anything.
     */
    onFaceMetrics?: (m: { faceWidth: number; cx: number; cy: number }) => void;
    onError: (error: { state?: string; error?: Error }) => void;
}) {
    const t = useTranslations('auth');
    const frameRef = useRef<HTMLDivElement>(null);

    /**
     * AWS's own <video>, and the canvas the retouched preview is painted into.
     *
     * The element is theirs and appears asynchronously when their machine
     * mounts, so it is captured by the sampling loop below rather than by a
     * React ref — there is nothing of ours to attach one to.
     */
    const videoElRef = useRef<HTMLVideoElement | null>(null);
    const liveCanvasRef = useRef<HTMLCanvasElement>(null);
    /**
     * The glass copy of the preview — a second <video> on the SAME stream.
     *
     * Not a canvas and not a render loop: one decode upstream feeds both
     * elements, and CSS does the blur and the mask. See `.rz-live-glass` in
     * liveness.css for why a copy is needed at all (short version:
     * `backdrop-filter` does not render without GPU compositing, and an <img>
     * cannot copy a video).
     */
    const glassVideoRef = useRef<HTMLVideoElement>(null);
    /**
     * A tiny scratch canvas for finding the face, and when it last ran.
     *
     * `measureSkin` wants pixels, so the video has to be drawn somewhere first.
     * 128px wide is plenty — it samples on a step grid and is looking for a
     * head-sized region, not an eyelash — and it keeps the cost of this to a
     * `drawImage` onto something smaller than an icon.
     *
     * ⚠️ It holds the video COVER-CROPPED to the frame's shape, not the whole
     * sensor frame — see `drawProbe`. Everything measured from it is used to
     * place something in the frame's coordinates, and the frame shows a crop.
     */
    const faceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const faceAtRef = useRef(0);

    /**
     * The glass's silhouette mask: the composite, when it last ran, whether a
     * run is in flight, and how many times segmentation has failed in a row.
     *
     * `busy` is not a nicety. `segmentToMask` is async and slower than the
     * poll, so without it a device that cannot keep up queues a new
     * segmentation every tick and spends the whole check falling further
     * behind — on the one screen where losing frames fails the check outright.
     * Blocking means a slow device quietly runs the outline at a lower rate.
     */
    const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
    /**
     * The blurred silhouette — how close each pixel is to the person.
     *
     * Its own canvas rather than a second pass on the mask: the blur has to
     * happen to the silhouette ALONE. Blurring the composite would smear the
     * far field's flat `maxGlass` into the answer and there would be no
     * distance measure left in it.
     */
    const haloCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const maskAtRef = useRef(0);
    const maskBusyRef = useRef(false);
    const maskFailsRef = useRef(0);

    /**
     * The last face measurement, and how long the pane stays down for.
     *
     * `movingUntil` is a DEADLINE rather than a boolean: every measurement that
     * shows movement pushes it further out, so the pane only returns after a
     * genuinely quiet stretch. A boolean would flicker the glass back on
     * between two frames of a continuous movement, which is worse than either
     * state on its own.
     */
    const facePrevRef = useRef<{ cx: number; cy: number; faceWidth: number } | null>(null);
    const movingUntilRef = useRef(0);

    /*
     * The look, on the live camera.
     *
     * ⚠️ This changes what is on SCREEN and nothing else. AWS streams the
     * MediaStream track to Rekognition and runs its face-fit test against the
     * stream's geometry — neither reads the pixels painted over the video, and
     * the video element itself is untouched apart from being made transparent
     * (which does not stop it decoding, and does not stop `drawImage` reading
     * it). The check is performed on the unmodified camera. See the header of
     * `useLivePreview`; this separation is a security property, not a detail.
     */
    const live = useLivePreview({
        videoRef: videoElRef,
        canvasRef: liveCanvasRef,
        // NEVER on the live path, whatever `CAPTURE_PORTRAIT.enabled` says.
        //
        // The blur is for the PHOTOGRAPH and the screens that show it. Here it
        // would be a neural network per mask refresh on a device that is also
        // encoding and uploading video to Rekognition — the first thing to push
        // a weaker phone under the 15fps AWS refuses.
        //
        // Hard-coded rather than read from the flag so re-enabling the live
        // look (`CAPTURE_LIVE.enabled`) cannot quietly bring the blur back with
        // it. The preview and the photograph are meant to differ here.
        portrait: false,
    });

    /**
     * The best frame seen so far, with the score that won it the slot.
     *
     * ── Why a frame is kept at all ──────────────────────────────────────────
     * Grabbing at `onAnalysisComplete` returns a BLACK frame. By the time that
     * fires AWS has already stopped the recording and released the camera, so
     * the video element is still in the DOM but has no picture left in it —
     * which is exactly what shipped: a black rectangle where the face should be
     * for the whole checking state.
     *
     * ── Why the BEST and not the LAST ───────────────────────────────────────
     * This still is not only shown while the servers decide — it is also the
     * face the ID is compared against at `face-match`, so its sharpness turns
     * into a CompareFaces score. Keeping whichever frame happened to land on
     * the final tick meant shipping motion blur roughly as often as not: the
     * check ends right after the user has been moving.
     *
     * So every tick is scored and only a sharper one displaces the holder.
     * Scoring runs on a 96px downsample (`scoreFrameQuality`), which is the
     * same cheap Sobel pass the ID screen already does per frame.
     */
    const bestFrame = useRef<{
        canvas: HTMLCanvasElement;
        sharpness: number;
        at: number;
    } | null>(null);

    /**
     * The other half of the double buffer — the canvas the next poll draws
     * into, which is never the one `bestFrame` is holding.
     *
     * See the long note in the poll: drawing into the held canvas destroys the
     * best frame of the check the first time a draw comes back empty, because
     * `grabFrame` clears before it draws.
     */
    const scratch = useRef<HTMLCanvasElement | null>(null);

    /**
     * Ask the camera for more pixels than AWS does, before AWS asks.
     *
     * THE fix for a captured face that looks soft — AWS hardcodes a 640x480
     * request and offers no prop to change it, so the picture is a VGA frame
     * upscaled two and a half times into a 350x400 frame on a phone. See
     * `installCaptureQuality` in cameraShim.ts for why this edits the request
     * rather than the track, and `CAPTURE_RESOLUTION` for why 1280x960 and not
     * more.
     *
     * ⚠️ INSTALLED DURING RENDER, and it has to be. This is the one thing about
     * this file that looks wrong and is not.
     *
     * The obvious home is an effect. Effects run CHILD FIRST, and
     * `FaceLivenessDetectorCore` — which is our child — starts its state
     * machine from its own mount. So an effect here, of either kind, runs after
     * AWS has already begun acquiring the camera, the patch lands too late, and
     * the stream is VGA anyway. The failure mode is silent: no error, no
     * warning, just a setting that appears to do nothing. `/design/capture-lab`
     * prints the delivered stream size precisely so that this is visible rather
     * than believed.
     *
     * A parent's RENDER always precedes a child's mount, so this is the only
     * point in the lifecycle that is early enough. `useMemo` is the standard
     * way to say "once, during render" — the value is discarded; the call is
     * the point. Idempotent, so React's double-render in development costs
     * nothing.
     *
     * The removal stays in an effect, where cleanup belongs.
     */
    useMemo(() => {
        if (!CAPTURE_RESOLUTION.enabled) return;
        installCaptureQuality({
            width: CAPTURE_RESOLUTION.width,
            height: CAPTURE_RESOLUTION.height,
        });
    }, []);

    useEffect(() => () => uninstallCaptureQuality(), []);

    /**
     * Start the segmentation model downloading now, not at capture.
     *
     * ⚠️ This is warming it for the CAPTURE, not for the preview — the live
     * path passes `portrait: false` above and never segments anything. Worth
     * saying because the two lines look contradictory side by side: the flag is
     * read here and deliberately ignored there.
     *
     * It is ~250KB and the capture happens the instant the stream ends, so
     * fetching it then would add a visible stall between the last frame and the
     * verdict — on the one screen where a pause reads as a problem. The ten
     * seconds of the check are free time; this spends them.
     *
     * Fails soft: `applyPortrait` returns the original photograph when the
     * model never arrives.
     */
    useEffect(() => {
        // Two consumers now, and the live one needs it SOONER: the capture can
        // afford to wait for a download, but the glass's silhouette is wanted
        // the moment the camera opens and falls back to the ellipse until it
        // arrives. `kickstartSegmenter` loads both running modes and is
        // idempotent, so one call covers both.
        if (CAPTURE_PORTRAIT.enabled || CAPTURE_LIVE_GLASS.silhouette.enabled) {
            kickstartSegmenter();
        }
    }, []);

    /**
     * Has the camera ever produced a frame, and have we already said it
     * stopped?
     *
     * Refs rather than state: this fires once and nothing renders from it, and
     * a re-render inside the sampling loop would be pure cost.
     */
    const sawVideo = useRef(false);
    /** The SDK's REC indicator has been seen — recording genuinely started. */
    const sawRecording = useRef(false);
    const announcedEnd = useRef(false);
    /**
     * The processed capture, made once at stream-end and reused at
     * analysis-complete.
     *
     * `processFrame` runs a full look pipeline over a 1280x960 frame; doing it
     * twice for the same still would be visible on a phone that is also
     * uploading a video. It also guarantees the two callbacks describe the same
     * photograph, which a second run could not promise — the pipeline reads the
     * frame, and a reclaimed backing store between calls would file a different
     * picture than the one already on screen.
     */
    const producedRef = useRef<FaceCapture | null>(null);

    /**
     * The callback, kept current for a loop that captured its closure once.
     *
     * The sampling effect below has `[]` deps deliberately — it owns an
     * interval and a double-buffered canvas pair, and tearing those down
     * whenever a parent re-renders would be far worse than the problem. So the
     * prop is read through a ref instead of from the closure, and a caller
     * passing a fresh arrow function every render still gets its latest one.
     *
     * Updated in an effect rather than assigned during render: a write to a ref
     * mid-render is the immutability rule this folder already carries too much
     * of.
     */
    const streamEndedRef = useRef(onStreamEnded);
    useEffect(() => {
        streamEndedRef.current = onStreamEnded;
    }, [onStreamEnded]);

    /** Same treatment, same reason — see the note on `streamEndedRef`. */
    const cameraLiveRef = useRef(onCameraLive);
    useEffect(() => {
        cameraLiveRef.current = onCameraLive;
    }, [onCameraLive]);

    /** Same treatment, same reason — see the note on `streamEndedRef`. */
    const faceMetricsRef = useRef(onFaceMetrics);
    useEffect(() => {
        faceMetricsRef.current = onFaceMetrics;
    }, [onFaceMetrics]);

    useEffect(() => {
        const id = setInterval(() => {
            /*
             * ⚠️ BY CLASS, NEVER `querySelector('video')`. There are TWO videos
             * in this frame and the bare selector picks the wrong one.
             *
             * `.rz-live-glass` — our glass copy — is rendered BEFORE the
             * detector, so it is first in document order and a bare `video`
             * query returns it every time. It has no `srcObject` until this
             * loop gives it one, from AWS's element, so `videoWidth` is 0 and
             * the loop returns early on every tick. That is a deadlock, not a
             * near miss: the copy can only become live via the element the
             * query was supposed to find.
             *
             * Everything here hangs off finding AWS's <video>: the mirror is
             * written onto it, the best frame is drawn from it, the end of the
             * stream is detected around it, and `onCameraLive` is what takes
             * the standby mark down. When it resolves wrong, all four stop
             * silently — a mirrored preview, a black verdict, AWS's own
             * checking screen, and the Face ID mark sitting on a live camera.
             * Each was reported as its own bug; they are one line.
             *
             * The document fallback stays for a different failure: the detector
             * mounts parts of itself outside the subtree it was rendered into,
             * the same behaviour that made three scoped CSS overrides match
             * nothing. Safe — the class is the SDK's and only one widget is
             * ever mounted.
             */
            const video =
                frameRef.current?.querySelector<HTMLVideoElement>(
                    'video.amplify-liveness-video',
                ) ?? document.querySelector<HTMLVideoElement>('video.amplify-liveness-video');

            /*
             * ── The mirror, written where nothing can outrank it ────────────
             *
             * THE one place the preview's orientation is decided, from
             * `CAPTURE_MIRROR.enabled`. The SDK ships `transform: scaleX(-1)`
             * on this element, so both directions have to be stated: `none` to
             * remove their mirror, `scaleX(-1)` to keep it when ours agrees.
             *
             * Inline, not in `liveness.css`, and that is not a preference —
             * `!important` in a stylesheet BEATS an inline style, so a rule
             * there would pin this to one orientation and quietly ignore the
             * switch. Two earlier versions of that file did exactly that, in
             * opposite directions.
             *
             * It also settles the question of which element carries the flip
             * and whether our selector reaches it, which cost three attempts to
             * get wrong: this is the element, held directly.
             *
             * Guarded so it is a no-op on every tick but the first — assigning
             * an identical string still invalidates style on some engines, and
             * this runs several times a second beside a liveness check that
             * fails below 15fps.
             */
            const wanted = CAPTURE_MIRROR.enabled ? 'scaleX(-1)' : 'none';
            if (video && video.style.transform !== wanted) {
                video.style.transform = wanted;
            }

            /*
             * Point the glass copy at the same stream, once.
             *
             * Done here rather than in an effect because AWS's <video> appears
             * asynchronously inside their tree — this loop is already the thing
             * that waits for it. Assigning the same `srcObject` to a second
             * element is ordinary: the stream is the source, the elements are
             * just two views of it.
             */
            /*
             * ── Where the face is, on a slow clock ──────────────────────────
             *
             * The glass has a clear hole in it and that hole has to sit on the
             * person, so it is measured rather than assumed: a fixed centre is
             * wrong the moment somebody sits off to one side or leans back, and
             * being wrong here means frosting the one thing that must stay
             * sharp — the face they are aligning to an oval with.
             *
             * ⚠️ Deliberately slower than the poll. This runs beside a check
             * that AWS fails below 15fps, and a head does not move far in a
             * third of a second. `measureSkin` is cheap by design (see
             * skinMask.ts — it exists precisely because a real detector was too
             * expensive to run here) but cheap is not free.
             *
             * No face found leaves the last values in place rather than
             * snapping the hole back to the middle. A momentary miss — a turn,
             * a hand across the lens — should not make the pane jump.
             */
            const glass = glassVideoRef.current;
            // `Date.now()` here rather than the poll's own clock: this block
            // sits above where that is taken, and the two need not agree —
            // this is its own cadence.
            const tick = Date.now();
            if (glass && video?.videoWidth && tick - faceAtRef.current > FACE_TRACK_MS) {
                faceAtRef.current = tick;
                try {
                    const c = (faceCanvasRef.current ??= document.createElement('canvas'));
                    /*
                     * The frame's own shape, read from the element rather than
                     * assumed to be 350x400 — the design gallery and the bench
                     * draw this at other sizes, and a hard-coded aspect would
                     * crop the probe differently from the picture on screen.
                     */
                    const frameAspect =
                        glass.clientWidth && glass.clientHeight
                            ? glass.clientWidth / glass.clientHeight
                            : 350 / 400;
                    const w = CAPTURE_LIVE_GLASS.silhouette.enabled
                        ? CAPTURE_LIVE_GLASS.silhouette.maskWidth
                        : 128;
                    const drew = drawProbe(c, video, w, frameAspect);
                    const h = c.height;
                    const ctx = drew ? c.getContext('2d', { willReadFrequently: true }) : null;
                    if (ctx) {
                        const face = measureSkin(ctx.getImageData(0, 0, w, h).data, w, h);
                        if (face.box && face.share > 0.02) {
                            glass.style.setProperty('--live-glass-cx', face.cx.toFixed(3));
                            glass.style.setProperty('--live-glass-cy', face.cy.toFixed(3));
                            /*
                             * The hole is wider than the face. A head is not
                             * skin all the way to its edge — hair, ears and jaw
                             * shadow all read as background to a skin measure —
                             * so a hole cut to the measured width would frost
                             * the outline of the very thing it is protecting.
                             */
                            /*
                             * The clear hole's RADIUS, as a fraction of the
                             * frame's width — which is exactly what
                             * `--live-glass-clear` now means in the stylesheet.
                             *
                             * ⚠️ These three numbers changed with the mask, and
                             * they are not a re-tune for looks. The old mask
                             * multiplied this by 190% before using it, so the
                             * same value described a hole nearly twice this
                             * size. Carrying the old numbers across would have
                             * left a clear area covering most of the frame and
                             * no visible gradient at all.
                             *
                             * `faceWidth` is the face's width as a fraction of
                             * the frame, so half of it is the face's own radius.
                             * 0.95 is a little under twice that — the hole
                             * comfortably contains the head, including the hair
                             * and jaw shadow that a skin measure reads as
                             * background.
                             *
                             * ⚠️ The FLOOR is the important number, not the
                             * multiplier.
                             *
                             * This is a skin-tone estimate, not a detector, and
                             * when it is wrong it is wrong about where the face
                             * is. A small hole placed slightly off frosts the
                             * one thing that must stay sharp, and the person
                             * cannot align to an oval they cannot see through a
                             * blur. AWS then times out waiting for a match.
                             *
                             * So the hole is never small. A clear area larger
                             * than it needs to be costs a little of the effect;
                             * one that is too small costs the check.
                             */
                            const clear = Math.min(
                                0.58,
                                Math.max(0.32, face.faceWidth * 0.95),
                            );
                            glass.style.setProperty('--live-glass-clear', clear.toFixed(3));

                            /*
                             * ── Are they moving? ───────────────────────────
                             *
                             * Position and size together, because coming
                             * CLOSER is the movement this screen asks for and
                             * it barely shifts the centre — AWS's whole hint is
                             * "move a little closer", so a test that only
                             * watched cx/cy would miss the one motion that
                             * matters and glass their face while they made it.
                             */
                            const prev = facePrevRef.current;
                            if (prev) {
                                const moved =
                                    Math.hypot(face.cx - prev.cx, face.cy - prev.cy) +
                                    Math.abs(face.faceWidth - prev.faceWidth);
                                if (moved > CAPTURE_LIVE_GLASS.settle.moveThreshold) {
                                    movingUntilRef.current =
                                        tick + CAPTURE_LIVE_GLASS.settle.holdMs;
                                }
                            }
                            facePrevRef.current = {
                                cx: face.cx,
                                cy: face.cy,
                                faceWidth: face.faceWidth,
                            };

                            // Reported on the same clock it was measured on —
                            // the caller needs no loop of its own.
                            faceMetricsRef.current?.({
                                faceWidth: face.faceWidth,
                                cx: face.cx,
                                cy: face.cy,
                            });
                        } else {
                            /*
                             * No face found — a turn, a hand across the lens,
                             * somebody stepping out of shot. The mask describes
                             * a person who is not there, so the pane comes down
                             * for the same reason it does while they move.
                             */
                            movingUntilRef.current =
                                tick + CAPTURE_LIVE_GLASS.settle.holdMs;
                        }
                    }
                } catch {
                    // A tainted or not-yet-ready frame. The pane keeps whatever
                    // it had, which is always a usable value.
                }
            }

            /*
             * ⚠️ NOTHING HIDES THE PANE HERE, deliberately.
             *
             * An earlier version faded the whole thing out whenever anybody
             * moved. It was wrong in both directions: the smallest shift took
             * the glass away, and it took the ROOM's glass with it when the
             * only thing at risk was the person. Movement is handled where it
             * belongs — by growing the cutout while the mask is being rebuilt
             * (see `settle.grow` in the silhouette block above), so the pane
             * over everything else never moves.
             */

            /*
             * ── The silhouette: glass over everything EXCEPT the person ──────
             *
             * The ellipse in `liveness.css` is a circle around a face. This is
             * the actual outline — head, shoulders, arms — so the room is
             * glassed and the administrator is not, which is the whole ask.
             *
             * ⚠️ Reuses the probe the face track just drew, and that is not
             * only an optimisation: the two must agree about WHERE things are.
             * A mask built from a differently-cropped frame than the one the
             * ramp is positioned in lands offset from the person it is cut
             * around, and the symptom is a glassy edge down one side of them.
             *
             * `busy` blocks overlap; see the ref's note. `giveUpAfter` stops a
             * missing model from being asked the same question 150 times.
             */
            const sil = CAPTURE_LIVE_GLASS.silhouette;
            const probe = faceCanvasRef.current;
            if (
                sil.enabled &&
                glass &&
                probe?.width &&
                !maskBusyRef.current &&
                maskFailsRef.current < sil.giveUpAfter &&
                tick - maskAtRef.current > sil.refreshMs
            ) {
                maskAtRef.current = tick;
                maskBusyRef.current = true;
                void (async () => {
                    try {
                        /*
                         * `VIDEO` mode with a monotonic timestamp — MediaPipe
                         * rejects a frame whose timestamp did not advance, and
                         * the poll's own `Date.now()` is exactly that.
                         */
                        const person = await segmentToMask(probe, {
                            mode: 'VIDEO',
                            timestamp: tick,
                        });
                        if (!person) {
                            // Includes the sanity bounds: a mask claiming the
                            // whole frame or none of it is not a person in a
                            // room, and the ellipse is better than a guess.
                            maskFailsRef.current += 1;
                            return;
                        }
                        maskFailsRef.current = 0;

                        const w = probe.width;
                        const h = probe.height;
                        const out = (maskCanvasRef.current ??=
                            document.createElement('canvas'));
                        if (out.width !== w || out.height !== h) {
                            out.width = w;
                            out.height = h;
                        }
                        const mctx = out.getContext('2d');
                        if (!mctx) return;
                        mctx.clearRect(0, 0, w, h);

                        /*
                         * ── The gradient, measured from the PERSON'S OUTLINE ──
                         *
                         * Three steps, and the middle one is the whole idea.
                         *
                         * A radial gradient cannot express this. Distance from
                         * a silhouette is not distance from a point — it has
                         * the shape of the person — and the previous version
                         * measured from their face's centre, which put the
                         * entire useful range inside the area that then got
                         * erased. See `spread` in capture.ts.
                         *
                         * Blurring the silhouette IS a distance measure: a wide
                         * Gaussian over a filled shape stays at 1 inside it and
                         * decays smoothly outward, so at any pixel the result
                         * says "how close is the nearest part of this person".
                         * One `drawImage` with a filter, no per-pixel work.
                         */
                        const { minGlass, maxGlass, spread, settle } =
                            CAPTURE_LIVE_GLASS;
                        // ⚠️ /100 — these are PERCENTAGES. Canvas alpha is
                        // 0..1, and 75 clamps to 1, which paints the whole pane
                        // opaque and looks exactly like the gradient failing.
                        const maxA = maxGlass / 100;
                        const minA = minGlass / 100;

                        // 1. The far field: uniform, at full strength.
                        mctx.fillStyle = `rgba(0, 0, 0, ${maxA.toFixed(4)})`;
                        mctx.fillRect(0, 0, w, h);

                        // 2. Take it back down toward `minGlass` near them.
                        const halo = (haloCanvasRef.current ??=
                            document.createElement('canvas'));
                        if (halo.width !== w || halo.height !== h) {
                            halo.width = w;
                            halo.height = h;
                        }
                        const hctx = halo.getContext('2d');
                        if (!hctx) return;
                        hctx.clearRect(0, 0, w, h);
                        hctx.filter = `blur(${Math.max(1, Math.round(spread * w * 0.5))}px)`;
                        hctx.drawImage(person.alpha, 0, 0, w, h);
                        hctx.filter = 'none';

                        /*
                         * `destination-out` leaves `dst * (1 - src)`, which is
                         * multiplicative — so the amount removed has to be
                         * expressed as a FRACTION of what is there, not as a
                         * difference. At `globalAlpha = (max - min) / max` and
                         * a halo of 1 the result is exactly `min`; at a halo of
                         * 0 it is untouched at `max`. Everything between is the
                         * gradient.
                         */
                        mctx.globalCompositeOperation = 'destination-out';
                        mctx.globalAlpha = maxA > 0 ? (maxA - minA) / maxA : 0;
                        mctx.drawImage(halo, 0, 0, w, h);
                        mctx.globalAlpha = 1;

                        /*
                         * 3. The person themselves: fully clear. Their alpha
                         * arrives FEATHERED, which is what keeps this from
                         * reading as a cut-out around the hair.
                         */
                        mctx.drawImage(person.alpha, 0, 0, w, h);

                        /*
                         * ── Grown while they are moving ────────────────────
                         *
                         * The outline is up to `refreshMs` old, so somebody
                         * leaning toward the camera is already outside it — and
                         * the glass slides onto their face, at the exact moment
                         * AWS is telling them to come closer.
                         *
                         * Widening the CUTOUT fixes that without touching the
                         * pane over the room, which is not stale and has no
                         * reason to flinch. A blurred silhouette drawn
                         * repeatedly pushes its soft edge outward — each pass
                         * multiplies what is left by `(1 - src)` — which is a
                         * cheap dilation and costs three composites of an
                         * image already in hand.
                         */
                        if (settle.enabled && Date.now() < movingUntilRef.current) {
                            mctx.filter = `blur(${Math.max(1, Math.round(settle.grow * w))}px)`;
                            for (let pass = 0; pass < 3; pass++) {
                                mctx.drawImage(person.alpha, 0, 0, w, h);
                            }
                            mctx.filter = 'none';
                        }

                        mctx.globalCompositeOperation = 'source-over';

                        /*
                         * ⚠️ DECODED BEFORE IT IS APPLIED. Assigning a
                         * mask-image the browser has not decoded yet paints the
                         * element UNMASKED for those frames — a full-strength
                         * blur across the whole camera, twice a second. It
                         * reads as flickering, and the cause is invisible.
                         */
                        const url = out.toDataURL('image/png');
                        const img = new Image();
                        img.src = url;
                        await img.decode();

                        const value = `url("${url}")`;
                        for (const prop of ['mask-image', '-webkit-mask-image']) {
                            glass.style.setProperty(prop, value);
                        }
                        /*
                         * ⚠️ The composite MUST be reset to `add`.
                         *
                         * The stylesheet's fallback is two layers combined with
                         * `intersect`. This is one layer, and `intersect` on a
                         * single layer intersects it with the transparent
                         * backdrop — which is empty, so the pane would vanish
                         * entirely rather than merely look wrong.
                         */
                        glass.style.setProperty('mask-composite', 'add');
                        glass.style.setProperty('-webkit-mask-composite', 'source-over');
                        glass.style.setProperty('mask-size', '100% 100%');
                        glass.style.setProperty('-webkit-mask-size', '100% 100%');
                    } catch {
                        // A tainted frame, a lost WebGL context, a model that
                        // never arrived. The ellipse in the stylesheet is still
                        // in force until a mask is successfully applied.
                        maskFailsRef.current += 1;
                    } finally {
                        maskBusyRef.current = false;
                    }
                })();
            }

            if (glass && video?.srcObject && glass.srcObject !== video.srcObject) {
                glass.srcObject = video.srcObject;
                // Mirrored to match, or the glassed edges would be a flipped
                // version of the sharp centre they surround.
                glass.style.transform = wanted;
                void glass.play().catch(() => {
                    // Autoplay refusals are survivable: the pane simply does
                    // not appear, and the plain camera underneath is correct.
                });
            }

            /*
             * ── The camera is done ───────────────────────────────────────────
             *
             * Two signals, because the obvious one is not the one that fires.
             *
             * The video going away is the intuitive end of a stream, and it is
             * NOT what happens: AWS leaves the element mounted, still carrying
             * its dimensions, and simply covers it with its own black
             * "Checking…" overlay while it uploads and analyses. So a check for
             * a missing video waits the full five to ten seconds and then
             * reports an end that already happened — which is exactly the black
             * frame this was supposed to remove.
             *
             * `.amplify-liveness-loader` is that overlay's spinner. It appears
             * the moment recording stops, which is the moment worth having.
             *
             * `sawVideo` gates both: the SDK shows a connecting loader BEFORE
             * the stream too, and firing on that would blank the frame before
             * the camera ever opened.
             */
            /*
             * ⚠️ `.amplify-loader` IS IN THIS LIST, and it is the one that
             * actually fires.
             *
             * The liveness-prefixed loaders are the SDK's own named ones; the
             * spinner it puts beside "Checking…" is the GENERIC Amplify loader,
             * with no liveness prefix at all. Watching only the prefixed
             * classes meant the sole surviving signal was the REC badge
             * unmounting — and AWS keeps its state machine in `recording` while
             * it flushes the upload, so that badge lives for the whole
             * analysis. The verdict therefore arrived at the same moment the
             * black screen ended, which is no better than not arriving.
             *
             * The blue dot on that screen is this element. It appears the
             * instant recording stops, which is the moment worth having.
             */
            const loader = (frameRef.current ?? document).querySelector(
                '.amplify-liveness-loader, .amplify-liveness-centered-loader, .amplify-loader',
            );

            /*
             * ⚠️ RENDERED, not merely present.
             *
             * `querySelector` finding the node is not the same as the user
             * seeing it. The SDK keeps a loader in the tree from the moment it
             * mounts, so a bare existence check matched on the very first tick
             * after the video appeared — and the checking state covered the
             * camera the instant it opened, for the whole session.
             *
             * `getClientRects()` is empty for anything `display:none`, detached,
             * or zero-sized, which is exactly the distinction needed and is
             * cheaper than reading a computed style.
             */
            const checkingOverlay = !!loader && loader.getClientRects().length > 0;

            /*
             * ── The signal that does not depend on how we styled anything ───
             *
             * `amplify-liveness-fade-out` is added by the SDK the instant
             * recording stops — `isRecordingStopped && LivenessClassNames.FadeOut`
             * in LivenessCameraModule, on the video and the oval wrapper.
             *
             * It is the best of the three and should be preferred, because it
             * is a CLASS rather than a rendered box. Every other signal here
             * has been broken at least once by our own stylesheet: the REC
             * badge is `display: none`, the loader was too, and each time the
             * detector went quiet and the symptom was seconds of black with
             * nothing in the console. A class cannot be hidden.
             */
            const fadedOut = !!(frameRef.current ?? document).querySelector(
                '.amplify-liveness-fade-out',
            );

            /*
             * The red REC pill, which the SDK shows only while it is actually
             * recording. Watching for it makes the sequence unambiguous —
             * camera up → recording → recording over — instead of inferring the
             * end from a loader that could in principle flash during the
             * countdown or a reconnect.
             *
             * Once recording has been seen, its DISAPPEARANCE is itself the
             * end of the stream, and the most direct signal of the three.
             */
            const rec = (frameRef.current ?? document).querySelector(
                '.amplify-liveness-recording-icon, .amplify-liveness-recording-icon-container',
            );

            /*
             * ⚠️ PRESENCE, not visibility — and the difference is the whole
             * bug this line used to be.
             *
             * It tested `getClientRects().length > 0`, by analogy with the
             * loader below. That is correct for the loader, which the SDK keeps
             * mounted and merely hides. It is exactly wrong here, because
             * `liveness.css` sets `display: none` on
             * `.amplify-liveness-recording-icon-container` — WE hide the REC
             * badge, deliberately, as part of dressing the widget.
             *
             * So the visibility test could never pass, `sawRecording` never
             * became true, the whole gate never opened, and the checking state
             * never arrived. Our own stylesheet defeated our own detector, in
             * both the real screen and the bench, with nothing to see but AWS's
             * black "Checking…" for the full analysis.
             *
             * Presence is the right test because the SDK renders this element
             * CONDITIONALLY — `isRecording && createElement(DefaultRecordingIcon)`
             * in LivenessCameraModule. It is in the tree if and only if
             * recording is happening, whatever we do to it with CSS.
             */
            const recording = !!rec;
            if (recording) sawRecording.current = true;

            /*
             * ⚠️ RECORDING MUST HAVE STARTED. Every signal is gated on it, and
             * that gate is the whole correctness of this.
             *
             * The loader and the missing-video checks looked like independent
             * confirmations and were nothing of the kind. AWS's sequence is:
             * camera preview live → user starts → CONNECTING, with a visible
             * loader over a live camera → countdown → recording. So a loader
             * check that only required "the video has appeared" fired during
             * connecting, and the glass replaced the camera before the check
             * had begun — with AWS's own "move a little closer" hint still
             * legible underneath it.
             *
             * Once the REC indicator has genuinely been seen, all three mean
             * the same thing and the first to arrive wins:
             *   recording stopped   the direct one
             *   loader visible      AWS is uploading and analysing
             *   video gone          the SDK tore its tree down
             *
             * If the indicator never appears — a renamed class in some future
             * version — nothing fires and the screen behaves exactly as it did
             * before any of this: AWS's own checking screen until the analysis
             * returns. A dull failure, not a broken one, which is the right
             * way round for a detector we do not own.
             */
            /*
             * ⚠️ A KEPT FRAME IS A PRECONDITION, not a detail.
             *
             * Every signal below says "recording is over"; none of them says
             * "we have a picture". They are not the same, and the gap between
             * them is one poll tick — long enough for `fadedOut` to be true on
             * the very tick recording starts, which fired the handover with
             * `bestFrame` still empty. The caller then got `capture: null`, set
             * no snapshot, and the whole checking state rendered over BLACK
             * with the mark floating on it.
             *
             * That is the regression this guard exists for, and the condition
             * is the honest one: do not announce the end of a stream we have
             * nothing from. If no frame is ever kept, nothing fires and the
             * screen falls back to `onAnalysisComplete` — the behaviour from
             * before any of this, which is dull rather than broken.
             */
            const ended =
                sawRecording.current &&
                !!bestFrame.current &&
                (fadedOut || !recording || checkingOverlay || !video?.videoWidth);

            if (sawVideo.current && !announcedEnd.current && ended) {
                announcedEnd.current = true;
                // One line, once per check. The signal that fired is the first
                // thing worth knowing if this ever mistimes again, and there is
                // no other way to see it from outside.
                console.log(
                    `[liveness] stream ended — fadeOut:${fadedOut} recording:${recording} loader:${checkingOverlay} video:${!!video?.videoWidth}`,
                );

                /*
                 * Produce the photograph NOW, and hand it over with the event.
                 *
                 * Async inside an interval tick, deliberately not awaited: the
                 * loop must not stall, and the caller is already showing the
                 * checking state by the time this resolves — it simply arrives
                 * with a face instead of without one.
                 */
                void (async () => {
                    const canvas = bestFrame.current?.canvas;
                    const usable = canvas?.width && frameHasContent(canvas);
                    producedRef.current = usable ? await processFrame(canvas) : null;
                    // One line per check. If the verdict ever renders over
                    // black again, this says whether the camera had a picture
                    // to give — which is the fork the last three fixes were
                    // guessing at from the outside.
                    console.log(
                        `[liveness] handover — kept:${!!canvas} usable:${!!usable} produced:${!!producedRef.current}`,
                    );

                    /*
                     * ⚠️ Only hand over if there is something to hand over.
                     *
                     * The caller moves the screen to `checking` on this call,
                     * and `checking` draws a photograph. Firing it with `null`
                     * put the glass and the mark over the frame's own black for
                     * the whole analysis — which looks exactly like the glass
                     * failing, and is what sent the last three fixes hunting in
                     * the wrong place.
                     *
                     * With no picture, nothing fires and the screen behaves as
                     * it did before any of this: AWS's own state until
                     * `onAnalysisComplete`. Dull, and honest.
                     */
                    if (producedRef.current) {
                        streamEndedRef.current?.(producedRef.current);
                    } else {
                        // Let it be retried on a later tick rather than sealing
                        // the handover off after one empty attempt.
                        announcedEnd.current = false;
                    }
                })();
                return;
            }

            if (!video?.videoWidth) return;
            // The first frame with real dimensions — the moment the camera is
            // genuinely showing something, and the moment the caller's standby
            // mark should come down.
            if (!sawVideo.current) cameraLiveRef.current?.();
            sawVideo.current = true;
            // Hand the element to the live preview, which has no other way to
            // find it — it is created inside AWS's tree.
            videoElRef.current = video;

            const held = bestFrame.current;
            const score = scoreFrameQuality(video);

            /*
             * The first usable frame is taken unconditionally, whatever it
             * scores.
             *
             * A quality floor here would be a regression waiting for a dim
             * room: every frame rejected, nothing kept, and the checking state
             * back to a black rectangle. A mediocre still is worth having; the
             * ranking below is what makes it better than mediocre.
             */
            if (held && score) {
                const stale = Date.now() - held.at > BEST_FRAME_WINDOW_MS;
                if (!stale && score.sharpness <= held.sharpness) return;
            }

            /*
             * The whole sensor frame — `grabFrame` owns that decision now, and
             * `CAPTURE_FRAMING` explains it. In short: this used to pre-crop to
             * the viewfinder's 0.875 and threw away a third of the width doing
             * it, which is most of what "the picture is a face and nothing
             * else" was describing. The 350x400 frame crops it at display
             * instead, to the same pixel, over more picture.
             */
            /*
             * ── Double-buffered, and it has to be ───────────────────────────
             *
             * Reuse is not optional: the capture is the full sensor frame now,
             * ~4.9MB of backing store at 1280x960, so allocating one per poll
             * hands the browser a quarter of a gigabyte of short-lived
             * canvases over a ten-second check. It discards backing stores
             * under that, and a discarded canvas is transparent — which
             * encodes to a BLACK JPEG.
             *
             * ⚠️ But reusing the HELD canvas is worse, and that was the first
             * attempt at this fix. `grabFrame` assigns width/height (which
             * CLEARS the canvas) and then draws — so a draw that produces
             * nothing wipes the good frame we were holding, IN PLACE, because
             * the thing being drawn into is the very object `bestFrame` points
             * at. One bad poll and the best frame of the whole check is blank.
             *
             * So: draw into a scratch canvas, and only once it is known good,
             * SWAP it with the held one. Two canvases alive, never more, and
             * the held frame is never written to while it is the held frame.
             */
            const canvas = grabFrame(video, scratch.current);
            if (!canvas) return;
            scratch.current = canvas;

            /*
             * Never keep a blank.
             *
             * `grabFrame` already refuses a video with no decoded frame, so
             * this catches what that guard cannot see — a backing store
             * discarded between one poll and the next, or a decoded frame that
             * is genuinely empty. Without it, a blank that happens to be the
             * last frame kept becomes the photograph on the identity record.
             *
             * NOT a quality floor. A dim room still keeps its frame; see the
             * note above about the checking state going black.
             */
            if (!frameHasContent(canvas)) return;

            // The swap. The old best becomes the next scratch, so nothing is
            // allocated and nothing that is still needed is drawn over.
            scratch.current = held?.canvas ?? null;
            bestFrame.current = {
                canvas,
                sharpness: score?.sharpness ?? 0,
                at: Date.now(),
            };
        }, FRAME_POLL_MS);
        return () => clearInterval(id);
    }, []);

    return (
        <div
            ref={frameRef}
            className="rz-liveness absolute inset-0"
            // Drives the two rules in liveness.css that make AWS's video
            // transparent and their module's backdrop see-through, so the
            // canvas below shows instead. Only set once the canvas is actually
            // painting — otherwise a device whose governor gave up would be
            // left looking at a black frame with a hidden video behind it.
            data-live={live.active ? 'on' : undefined}
        >
            {/*
              The retouched preview.

              FIRST in the DOM on purpose, so it paints beneath everything
              Amplify renders — their chrome, the hint pill and the freshness
              flash all stay on top with no z-index to keep in sync. The two
              CSS rules keyed off `data-live` are what let it show through.
            */}
            <canvas
                ref={liveCanvasRef}
                aria-hidden
                className="rz-live-canvas pointer-events-none absolute inset-0 h-full w-full object-cover"
            />

            {/* The live glass. Rendered only when switched on, so turning it
                off mounts nothing rather than leaving an invisible video
                decoding a second copy of the stream. */}
            {CAPTURE_LIVE_GLASS.enabled && (
                <>
                    {/* The refraction, on its own id.
                        ⚠️ NOT shared with the checking pane's filter. They run
                        at very different strengths — this one is deliberately
                        weak because it bends live video at 30fps — and one id
                        would mean one of them silently taking the other's
                        scale, with the symptom being either a flat pane or a
                        dropped framerate. */}
                    <GlassFilter
                        id={LIVE_GLASS_FILTER_ID}
                        scale={CAPTURE_LIVE_GLASS.warpScale}
                        blur={CAPTURE_LIVE_GLASS.warpBlur}
                    />
                    <video
                        ref={glassVideoRef}
                        aria-hidden
                        playsInline
                        muted
                        className="rz-live-glass"
                        style={
                            {
                                '--live-glass-blur': `${CAPTURE_LIVE_GLASS.blur * 0.0625}rem`,
                                '--live-glass-saturation': CAPTURE_LIVE_GLASS.saturation,
                                /*
                                 * ⚠️ /100 — the config is in PERCENT, CSS alpha
                                 * is 0..1. Handing `rgb(0 0 0 / 75)` to the
                                 * parser is not "75%", it is an out-of-range
                                 * number that clamps to fully opaque — so the
                                 * ellipse fallback would render as a solid
                                 * sheet with a hole in it, with no error
                                 * anywhere.
                                 */
                                '--live-glass-max': CAPTURE_LIVE_GLASS.maxGlass / 100,
                                '--live-glass-min': CAPTURE_LIVE_GLASS.minGlass / 100,
                                '--live-glass-clear': CAPTURE_LIVE_GLASS.clear,
                                /*
                                 * `none` at zero, and that is the fallback
                                 * path, not a tidy-up. An invalid or missing
                                 * `url()` invalidates the WHOLE `filter`
                                 * declaration — taking the blur and the
                                 * saturation with it — so a scale of 0 must
                                 * produce a valid keyword rather than a dead
                                 * reference. Same trap the checking pane hit.
                                 */
                                '--live-glass-warp': CAPTURE_LIVE_GLASS.warpScale
                                    ? `url(#${LIVE_GLASS_FILTER_ID})`
                                    : 'none',
                            } as React.CSSProperties
                        }
                    />
                </>
            )}

            <ThemeProvider theme={livenessTheme}>
                <FaceLivenessDetectorCore
                    sessionId={sessionId}
                    region={region}
                    // AWS's instruction screen repeats the caption above the
                    // frame and adds a tap nobody needs.
                    disableStartScreen
                    config={{
                        credentialProvider,
                        binaryPath: TFJS_WASM_PATH,
                        faceModelUrl: blazefaceModelUrl(),
                    }}
                    components={{
                        /*
                         * The default is a full-width blue alert stacked ABOVE
                         * the camera, inside our 400-tall frame — it took 152 of
                         * those 400 and pushed the picture out of the bottom.
                         *
                         * The warning itself is NOT dropped. This check flashes
                         * coloured light and someone photosensitive is entitled
                         * to know before it starts; it moves to the caption
                         * block each screen renders above the frame, which is
                         * ours, is translated, and is readable — nothing inside
                         * the frame is, once the oval fills it and the surround
                         * turns white mid-check.
                         */
                        PhotosensitiveWarning: () => null,
                    }}
                    // Every word the widget can show. Without this it speaks
                    // English regardless of the chosen locale, which would be
                    // the only screen in the app that does (AGENTS.md §9).
                    displayText={{
                        hintMoveFaceFrontOfCameraText: t('faceNoFace'),
                        hintTooManyFacesText: t('faceMultiple'),
                        hintFaceDetectedText: t('faceHold'),
                        hintCanNotIdentifyText: t('faceNoFace'),
                        hintTooCloseText: t('faceTooClose'),
                        hintTooFarText: t('faceTooFar'),
                        hintConnectingText: t('faceLoading'),
                        hintVerifyingText: t('faceChecking'),
                        hintCheckCompleteText: t('faceChecking'),
                        hintIlluminationTooBrightText: t('faceTooBright'),
                        hintIlluminationTooDarkText: t('faceTooDark'),
                        hintIlluminationNormalText: t('faceHold'),
                        hintHoldFaceForFreshnessText: t('faceHold'),
                        hintCenterFaceText: t('faceOffCentre'),
                        hintCenterFaceInstructionText: t('faceOffCentre'),
                        hintFaceOffCenterText: t('faceOffCentre'),
                        recordingIndicatorText: t('livenessRecording'),
                        cancelLivenessCheckText: t('livenessCancel'),
                        waitingCameraPermissionText: t('faceLoading'),
                        retryCameraPermissionsText: t('deviceRetry'),
                    }}
                    onAnalysisComplete={async () => {
                        /*
                         * The kept frame, through the look pipeline.
                         *
                         * ── What changed, and what did not ─────────────────
                         * A background-blur and relighting pipeline used to sit
                         * inline here and was reverted, because every version
                         * of it that looked right in one room looked wrong in
                         * the next (`git log` 7cecf4b, 5d7f21c). What runs now
                         * is not that: the corrections in `captureLook` are
                         * MEASURED off each frame rather than dialled in, which
                         * is the property the reverted version lacked and the
                         * only reason to expect this one to hold up. The
                         * portrait blur — the part that genuinely is a look —
                         * is off by default and judged on /design/capture-lab.
                         *
                         * `processFrame` never throws and never returns
                         * nothing: every stage inside it falls back to the
                         * frame as the camera gave it. The floor here is the
                         * photograph that shipped before any of this existed.
                         */
                        // Already made at stream-end, five to ten seconds ago.
                        // Reused rather than remade — see `producedRef`.
                        if (producedRef.current) {
                            return onAnalysisComplete(producedRef.current);
                        }

                        const canvas = bestFrame.current?.canvas;
                        if (!canvas?.width) return onAnalysisComplete(null);

                        // Checked once more HERE, at the only moment that
                        // actually matters. The poll rejects blanks as they
                        // arrive, but the kept canvas sat in memory for the
                        // length of the check and the browser may have
                        // reclaimed it in between. Reporting no capture is
                        // honest and the screens already handle it; filing a
                        // black rectangle as somebody's identity photograph is
                        // not.
                        if (!frameHasContent(canvas)) {
                            console.warn('[liveness] kept frame was blank — no capture filed');
                            return onAnalysisComplete(null);
                        }

                        return onAnalysisComplete(await processFrame(canvas));
                    }}
                    onError={onError}
                />
            </ThemeProvider>

            {/* The face-mesh overlay was removed by request — it drew a second
                ML model's landmarks over AWS's camera and did not read well.
                It was always a sibling that touched nothing of theirs, so its
                removal changes the check in no way. `git log` has it.

                ⚠️ The rule hiding AWS's oval used to name this overlay as its
                replacement guide. It is not one — it is gone, and the oval is
                hidden too, so the frame carries no guide at all. That is a
                decision, and liveness.css states what it costs. */}
        </div>
    );
}

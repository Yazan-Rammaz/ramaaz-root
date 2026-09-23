'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

import { TFJS_WASM_PATH, blazefaceModelUrl } from '@/features/kyc/config/liveness';
import {
    CAPTURE_LIVE_GLASS,
    CAPTURE_LIVE_MESH,
    CAPTURE_CAMERA_ZOOM,
    CAPTURE_LIVE_ZOOM,
    CAPTURE_MIRROR,
    MIRROR_CLASS,
    CAPTURE_PORTRAIT,
    CAPTURE_RESOLUTION,
} from '@/features/kyc/config/capture';
import { FaceMesh } from '@/features/kyc/components/FaceMesh';
import { useLivePreview } from '@/features/kyc/hooks/useLivePreview';
import { scoreFrameQuality } from '@/features/kyc/services/imageQuality';
import {
    frameHasContent,
    grabFrame,
    processFrame,
    type FaceCapture,
} from '@/features/kyc/services/faceCapture';
import { kickstartSegmenter } from '@/features/kyc/services/portrait';
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
/**
 * How long the glass copy is given to decode a frame before the pane is
 * assumed to be the only option.
 *
 * A grace period rather than a timeout worth tuning: an element that has not
 * produced a single frame of an already-playing stream in this long is not
 * slow, it is never going to.
 */
const GLASS_PROBE_MS = 900;

/**
 * How long without a face before the zoom gives up and goes home.
 *
 * Measured from the face mesh's last report rather than from AWS's hint,
 * because the hint is not guaranteed to say anything at all when somebody walks
 * away — the toast can simply go quiet. A second and a half is longer than any
 * blink or turn and shorter than anyone would notice.
 */
const FACE_LOST_MS = 1500;

/**
 * How long an `applyConstraints` may be outstanding before it is written off.
 *
 * ⚠️ THE GUARD THAT KEEPS THE ZOOM FROM WEDGING. The in-flight flag is what
 * lets the steps be small, and it is cleared by the promise — so a request that
 * never settles leaves it raised for ever and the controller stops looking at
 * anything, including the release. The symptom is a zoom stuck in at capture
 * with no error anywhere, which is precisely what a hung camera call produces.
 */
const ZOOM_STALL_MS = 2500;

/**
 * The amounts both panes are drawn from.
 *
 * One object, shared by the two elements, because they are the same pane drawn
 * two ways — and the moment their numbers can differ is the moment a browser
 * that switches between them shows two different looks for the same state.
 *
 * Only the STARTING placement is here. `FaceMesh` takes the position over on
 * its first detection and owns it from then on; see `placeGlass`, which also
 * explains why the two elements need different centres for the same face.
 */
const GLASS_VARS = {
    '--live-glass-blur': `${CAPTURE_LIVE_GLASS.blur * 0.0625}rem`,
    '--live-glass-saturation': CAPTURE_LIVE_GLASS.saturation,
    /*
     * ⚠️ /100 — `glass` is a PERCENTAGE and CSS alpha is 0..1. Handing the
     * parser a 40 is not "40%", it is an out-of-range number that clamps to
     * fully opaque, so the oval would render as a solid frosted disc on the
     * face.
     */
    '--live-glass-amount': CAPTURE_LIVE_GLASS.glass / 100,
    '--live-glass-feather': CAPTURE_LIVE_GLASS.ovalFeather,
    '--live-glass-cx': CAPTURE_LIVE_GLASS.faceX,
    '--live-glass-cy': CAPTURE_LIVE_GLASS.faceY,
    '--live-glass-rx': CAPTURE_LIVE_GLASS.face,
    '--live-glass-ry': CAPTURE_LIVE_GLASS.face * 1.3,
} as React.CSSProperties;

const FACE_TRACK_MS = 320;

/*
 * ⚠️ NO REFRACTION FILTER FOR THE LIVE PANE, and its absence is deliberate.
 *
 * It used to render its own `GlassFilter` and reference it from
 * `filter: url(#...)`. Two reasons it went, and either alone would be enough:
 *
 *   - the pane is a `backdrop-filter` now (see `.rz-live-glass`), and an SVG
 *     reference filter inside one is what cost three earlier rounds: it passes
 *     `@supports`, fails at paint, and an invalid `url()` invalidates the WHOLE
 *     declaration — blur and saturation included;
 *   - refraction is DISTORTION, and this pane exists to make a close-up lens
 *     look less distorted. See `CAPTURE_LIVE_GLASS`.
 *
 * `GlassFilter` is still used, and still needed, by the CHECKING pane.
 */

/**
 * The camera's zoom range.
 *
 * ⚠️ Declared here because `zoom` IS NOT IN THE DOM TYPES. It is a
 * well-supported MediaStreamTrack capability (the Image Capture spec) that
 * TypeScript's lib does not carry, so both the capability and the constraint
 * need widening. Casting at the call site instead would hide the fact that
 * these are real, spec'd fields rather than something invented here.
 */
interface ZoomRange {
    min: number;
    max: number;
    step: number;
}

/** What the zoom controller remembers between adjustments. */
interface ZoomState {
    /** Null once we know the camera cannot zoom — checked exactly once. */
    range: ZoomRange | null;
    checked: boolean;
    /** The last value the DEVICE accepted, in the camera's own units. */
    value: number;
    /**
     * The zoom we intend, as a float, before the device's granularity.
     *
     * ⚠️ THE REASON THE MOTION IS SMOOTH. Cameras quantise `zoom` to a `step`,
     * and some report a coarse one. An earlier version compared the next 4%
     * nudge against that step and, finding it smaller, SNAPPED IT OUT to a full
     * step so that something would happen — turning a glide into a staircase on
     * exactly the hardware that could least afford it.
     *
     * Tracking the intent separately fixes it at the root: this moves by 4%
     * whatever the device does, and it is only rounded to the grid at the
     * moment of applying. On a fine-grained camera every step lands; on a
     * coarse one several intents accumulate before the rounded value changes,
     * which is as smooth as that camera can be and never a forced jump.
     */
    desired: number;
    /** When it was applied, so `stepMs` can throttle. */
    at: number;
    /** Has the release already run? It must happen once, not every tick. */
    released: boolean;
    /** The bar at the previous adjustment, for spotting it going backwards. */
    lastBar: number;
    /**
     * Which way the last step went: +1 zooming in, -1 zooming out.
     *
     * ⚠️ A DIRECTION, not a "stop" flag. What replaced it: the previous version
     * latched on the first dip in the bar and never moved again, so one blink
     * halfway through froze the zoom for the whole check.
     */
    dir: 1 | -1;
    /**
     * An `applyConstraints` is in flight.
     *
     * ⚠️ The guard that lets the steps be small. A camera reconfiguration takes
     * real time — tens of milliseconds on a good phone, much more on a slow one
     * — and firing another before the last has settled builds a queue the
     * device works through long after the situation has changed. With this, a
     * slow camera simply takes larger intervals; a fast one glides.
     */
    busy: boolean;
    /**
     * The last phase written to the console.
     *
     * ⚠️ The zoom adjusts up to five times a second, and this code SHIPS. A
     * line per adjustment is a hundred lines per check in a production console
     * — not diagnostics, but noise that buries the `[liveness]` lines that are
     * genuinely once-per-check. Only transitions are worth saying: the moment
     * it starts pulling in, turns around, releases, or resets.
     */
    said: string;

    /**
     * Where the release is heading, set once when the match locks.
     *
     * Held rather than recomputed because it is derived from the zoom AT THE
     * MOMENT OF LOCK — recomputing it each tick from a value that is itself
     * falling would chase its own tail and stop short.
     */
    target: number | null;
}

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
    onStreamStopped,
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
     * The camera stopped — fired IMMEDIATELY, with the raw kept frame.
     *
     * ⚠️ This exists because `onStreamEnded` is not immediate. That one waits
     * for `processFrame`, which runs the whole look pipeline over a 1280x960
     * still — exposure, white balance, skin, lighting — and takes a beat. For
     * that beat the camera is already dead, so the frame is BLACK, and whatever
     * was drawn over the live preview is still drawn over nothing. Reported as
     * exactly that: the mesh hanging in the dark before the AI mark appeared.
     *
     * So the still is handed over twice. This is the raw sensor frame as a data
     * URL, available the instant recording stops, good enough to put something
     * true on screen; `onStreamEnded` follows with the processed one and
     * replaces it. The swap is invisible — both are the same photograph, and
     * the second is only better lit.
     */
    onStreamStopped?: (rawStill: string | null) => void;
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
    const glassVideoRef = useRef<HTMLSpanElement>(null);
    /**
     * The other way of drawing the same pane — a second <video> on AWS's
     * stream, blurred as an element.
     *
     * Both are rendered and one is chosen at runtime; see `.rz-live-glass`.
     * `glassMode` is null until the probe has an answer, which is what keeps a
     * browser capable of both from showing two panes at once.
     */
    const glassCopyRef = useRef<HTMLVideoElement>(null);
    const glassModeRef = useRef<'copy' | 'pane' | null>(null);
    const glassProbeAtRef = useRef(0);
    /** When the face mesh last reported a face — see `FACE_LOST_MS`. */
    const faceSeenAtRef = useRef(0);
    /**
     * AWS's match bar has existed at least once.
     *
     * ⚠️ Its DISAPPEARANCE is a signal, not an absence. The SDK unmounts the
     * instruction overlay when it leaves `ovalMatching` — which is the exact
     * moment it starts saying "hold still" — so the bar going away means the
     * match phase is over, and gating the controller on the element being
     * present skips the one tick the release needed to fire.
     */
    const sawBarRef = useRef(false);
    /*
     * ⚠️ THE MESH'S MODEL IS ALREADY LOADED BY THE TIME THIS MOUNTS.
     *
     * `FaceLivenessScreen` awaits `ensureLandmarker()` before it opens an AWS
     * session, so the ~15.5MB download happens ALONE on the connection, during
     * the standby screen, and is in the browser cache before the detector
     * exists. Mounting the mesh here therefore costs nothing.
     *
     * An earlier version deferred the mesh until AWS's match bar appeared,
     * which was worse in a way that is not obvious: it moved the download into
     * the middle of the check, where it competed with the video being streamed
     * to Rekognition on a screen AWS fails below 15fps. Sequencing beats
     * deferring — the problem was never WHEN it started but that it ran at the
     * same time as something that could not afford it.
     */
    /**
     * Has the face mesh taken over placing the glass oval?
     *
     * Two things can size that pane — the mesh's own bounding box and
     * `measureSkin` — and they must never both write it. They disagree by a few
     * percent, so alternating between them makes the oval twitch at whichever
     * rate the slower one runs. The mesh is exact (it IS the wireframe the pane
     * sits behind) and wins permanently once it has reported; the skin measure
     * covers only the window before the model has loaded.
     */
    const meshPlacesGlassRef = useRef(false);
    /**
     * The mesh's canvas, held here rather than inside `FaceMesh`.
     *
     * The zoom has to move the video, the glass and the mesh as ONE — their
     * coordinates are all in the video's frame, so scaling any of them alone
     * tears the overlay off the face it describes. That makes the transform a
     * property of the viewfinder rather than of any one layer, and this is
     * where the viewfinder lives.
     */
    const meshCanvasRef = useRef<HTMLCanvasElement | null>(null);

    /**
     * How full AWS's match bar is, 0..1 — THEIR number, not ours.
     *
     * `aria-valuenow` on `.amplify-liveness-match-indicator__bar`, which the
     * SDK updates as the face approaches its oval. Read rather than estimated
     * on purpose: any measurement of our own would be a second opinion about
     * whether somebody is close enough, and a gauge that disagrees with the
     * instruction beside it is worse than no gauge.
     *
     * Drives two things — how much of the mesh is green, and when the
     * viewfinder's zoom lets go.
     */
    const matchRef = useRef(0);

    /**
     * What AWS is currently ASKING the person to do: come closer, or move away.
     *
     * Read from the hint toast's visible text and compared against the very
     * strings we handed the SDK for those two states (`displayText` below), so
     * this cannot drift from what is on screen and works in all three
     * languages without a second mapping to keep in step.
     *
     * The zoom follows it directly: "too far" is the camera's cue to zoom in,
     * "too close" to back off. Every other hint — hold still, centre your face,
     * too bright — says nothing about distance and leaves the zoom alone.
     */
    const hintTextRef = useRef({ closer: '', away: '', hold: '', gone: '' });
    useEffect(() => {
        hintTextRef.current = {
            closer: t('faceTooFar'),
            away: t('faceTooClose'),
            hold: t('faceHold'),
            gone: t('faceNoFace'),
        };
    }, [t]);

    /**
     * The camera zoom controller's state. See `CAPTURE_CAMERA_ZOOM`.
     *
     * A ref rather than state: nothing renders from it, and it is written from
     * a callback that runs twenty times a second.
     */
    const zoomRef = useRef<ZoomState>({
        range: null,
        checked: false,
        value: 1,
        desired: 1,
        at: 0,
        released: false,
        lastBar: -1,
        dir: 1,
        busy: false,
        target: null,
        said: '',
    });

    /**
     * The video track currently being zoomed, kept for cleanup.
     *
     * ⚠️ Needed because the zoom must be PUT BACK. The track is AWS's and
     * belongs to a MediaStream the browser may hand to the next screen — the ID
     * capture, or a retry — and a camera left at 1.5x would silently crop those
     * too, with nothing on screen to explain it.
     */
    const zoomTrackRef = useRef<MediaStreamTrack | null>(null);

    /**
     * Put the glass oval exactly on the wireframe.
     *
     * `useCallback` with no deps: `FaceMesh` reads it through a ref, but a new
     * function identity every render would still churn that ref pointlessly on
     * a component that re-renders for unrelated reasons.
     */
    const handleMeshBounds = useCallback(
        (b: { cx: number; cy: number; rx: number; ry: number }) => {
            const glass = glassVideoRef.current;
            /*
             * ⚠️ The pane's mask is positioned in SCREEN coordinates, and the
             * preview is mirrored.
             *
             * The measurements below are taken from the unmirrored stream, so a
             * face at 0.3 across the video appears at 0.7 across the frame. The
             * mesh handles this by carrying the same `scaleX(-1)` as the video;
             * this pane cannot, because a transform on a `backdrop-filter`
             * element moves the element and what it samples together, which
             * mirrors the softened patch onto the wrong side of the face.
             *
             * So the flip is done to the NUMBER instead, once, here.
             */
            const screenX = (x: number) => (CAPTURE_MIRROR.enabled ? 1 - x : x);
            /**
             * Place the oval on whichever pane is live.
             *
             * ⚠️ The two need DIFFERENT centres for the same face. The copy
             * carries `scaleX(-1)` so its mask is flipped along with its
             * content and wants the raw, unmirrored measurement; the pane
             * cannot be transformed at all — a transform on a
             * `backdrop-filter` element moves what it samples too, mirroring
             * the softened patch onto the wrong side of the face — so its mask
             * is positioned in screen coordinates instead.
             */
            const placeGlass = (cx: number, cy: number, rx: number, ry: number) => {
                const set = (el: HTMLElement | null, x: number) => {
                    if (!el) return;
                    el.style.setProperty('--live-glass-cx', x.toFixed(4));
                    el.style.setProperty('--live-glass-cy', cy.toFixed(4));
                    el.style.setProperty('--live-glass-rx', rx.toFixed(4));
                    el.style.setProperty('--live-glass-ry', ry.toFixed(4));
                };
                set(glass, screenX(cx));
                set(glassCopyRef.current, cx);
            };
            if (!glass) return;
            meshPlacesGlassRef.current = true;
            faceSeenAtRef.current = Date.now();
            const pad = CAPTURE_LIVE_GLASS.ovalPad;
            placeGlass(b.cx, b.cy, b.rx * pad, b.ry * pad);

            if (!CAPTURE_LIVE_ZOOM.enabled) return;

            /*
             * ── The viewfinder's zoom ───────────────────────────────────────
             *
             * ⚠️ DISPLAY ONLY. This is a CSS transform on three sibling
             * elements. AWS reads the MediaStream track and measures against
             * the stream's geometry; the capture is `drawImage` on the video's
             * decoded frames. Neither can see a transform. It cannot make the
             * check easier and it cannot reach the photograph — see
             * `CAPTURE_LIVE_ZOOM` for why that matters and why it was asked
             * for anyway.
             */
            const released = matchRef.current >= CAPTURE_LIVE_ZOOM.releaseAt;
            const wanted = released
                ? 1
                : Math.min(
                      CAPTURE_LIVE_ZOOM.max,
                      Math.max(1, CAPTURE_LIVE_ZOOM.targetWidth / Math.max(0.05, b.rx * 2)),
                  );

            /*
             * Put the face in the middle. With `transform-origin` at the
             * centre, a point at fraction f lands at `0.5 + (f - 0.5) * z + t`,
             * so centring it means `t = -(f - 0.5) * z`.
             *
             * ⚠️ The SIGN FLIPS on a mirrored element. `scaleX(-1)` maps f to
             * 1 - f before the zoom sees it, so the same face sits on the other
             * side of centre and the correction has to go the other way. Get
             * this wrong and the zoom pushes the face off the frame instead of
             * onto the middle of it — at double the offset, so it is obvious,
             * but only once somebody sits off-centre.
             */
            const mirrored = CAPTURE_MIRROR.enabled;
            const tx = (mirrored ? b.cx - 0.5 : 0.5 - b.cx) * wanted * 100;
            const ty = (0.5 - b.cy) * wanted * 100;
            const zoom = `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%) scale(${wanted.toFixed(3)})`;

            /*
             * The three layers of the viewfinder move as one. The mesh's
             * coordinates and the glass's oval are both in the video's frame,
             * so anything that scales one and not the others tears them apart.
             *
             * The mirror is composed HERE rather than left on the elements:
             * `transform` is one property, so writing a zoom would otherwise
             * overwrite the flip the sampling loop put there.
             */
            const flip = mirrored ? ' scaleX(-1)' : '';
            const video = videoElRef.current;
            const mesh = meshCanvasRef.current;
            for (const el of [video, glass, mesh]) {
                if (!el) continue;
                el.style.transition = `transform ${CAPTURE_LIVE_ZOOM.ms}ms ease-out`;
                el.style.transform = `${zoom}${flip}`;
            }
        },
        [],
    );
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

    /*
     * ── There is no segmentation here, and that is a decision ───────────────
     *
     * A version of this cut the glass around the person's whole SILHOUETTE,
     * using the Selfie Segmenter. It was removed, for three reasons that
     * compounded:
     *
     *   - AWS's oval makes the face FILL the frame, so "everything except the
     *     person" was a narrow border. The 10→75 gradient had nowhere to live
     *     and the pane read as a flat wash.
     *   - a segmented outline is stale by its own runtime, not by the clock —
     *     up to 400ms — so it lagged behind anybody moving, which is the entire
     *     activity on a screen that keeps saying "move a little closer". It
     *     needed a dilate-while-moving hack to stay off their face.
     *   - it was a third neural network on this screen, beside the face mesh
     *     and AWS's own BlazeFace, with a 15fps floor underneath all of it.
     *
     * The head-shaped hole below comes from `measureSkin` instead: a chroma
     * scan over a 160px probe, running at `FACE_TRACK_MS` and eased by the
     * registered custom properties. Cheaper by orders of magnitude, never
     * stale, and the body now takes glass — which is what made the gradient
     * visible at all.
     */

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
     * Put the camera's zoom back on the way out.
     *
     * ⚠️ Not housekeeping. The track outlives this component — the browser hands
     * the same device to the ID capture screen and to a retry — so a camera left
     * at 1.5x would quietly crop those too, with nothing on screen to explain
     * why. `applyConstraints` on an ended track rejects, which is the normal
     * case here and is swallowed.
     */
    useEffect(
        () => () => {
            const track = zoomTrackRef.current;
            const range = zoomRef.current.range;
            zoomTrackRef.current = null;
            if (!track || !range) return;
            void track
                .applyConstraints({
                    advanced: [{ zoom: range.min } as MediaTrackConstraintSet],
                })
                .catch(() => {
                    /* The track has already stopped. Nothing to put back. */
                });
        },
        [],
    );

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
    /*
     * ⚠️ NOTHING OF OURS IS WARMED AT MOUNT, and that is a fix for a hard
     * failure rather than a nicety.
     *
     * Three models want this screen: AWS's own BlazeFace, MediaPipe's
     * FaceLandmarker for the mesh, and the Selfie Segmenter for the capture's
     * portrait blur. Started together they compete for one connection, and on a
     * slower link AWS's download loses — its detector then fails with
     * `RUNTIME_ERROR: Face detection model loading timed out`, which is not a
     * degraded look but a sign-in that cannot proceed. Observed on Windows
     * Chrome, where the mesh was missing in the same run because its model had
     * not arrived either.
     *
     * So ours wait until AWS's match bar appears, which is proof its model
     * loaded and it is measuring — see `assistOn` in the sampling loop. The
     * mesh then joins a second or two late, on a screen that stays interactive
     * for far longer than that. The capture's segmenter has even less to lose:
     * it is not needed until the stream ends.
     */

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
    const streamStoppedRef = useRef(onStreamStopped);
    useEffect(() => {
        streamStoppedRef.current = onStreamStopped;
    }, [onStreamStopped]);

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
            /*
             * ⚠️ ONLY UNTIL THE ZOOM TAKES OVER. `transform` is one property,
             * so once `handleMeshBounds` starts writing a zoom that composes
             * the flip itself, a bare mirror written here would overwrite it
             * five times a second — the viewfinder would jitter between zoomed
             * and not, which looks like the camera fighting itself.
             */
            const wanted = CAPTURE_MIRROR.enabled ? 'scaleX(-1)' : 'none';
            const zoomOwnsTransform =
                CAPTURE_LIVE_ZOOM.enabled && meshPlacesGlassRef.current;
            if (video && !zoomOwnsTransform && video.style.transform !== wanted) {
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
                    /*
                     * 160 rather than 128: `measureSkin` samples on a step
                     * grid, and the hole it produces is now the ONLY thing
                     * placing the glass — there is no segmenter behind it to
                     * correct a coarse read. The extra rows cost one larger
                     * `drawImage` onto something still smaller than an icon.
                     */
                    const w = 160;
                    const drew = drawProbe(c, video, w, frameAspect);
                    const h = c.height;
                    const ctx = drew ? c.getContext('2d', { willReadFrequently: true }) : null;
                    if (ctx) {
                        const face_ = measureSkin(ctx.getImageData(0, 0, w, h).data, w, h);
                        if (face_.box && face_.share > 0.02) {
                            /*
                             * ⚠️ FALLBACK ONLY. Once `FaceMesh` has reported,
                             * it owns the oval — see `meshPlacesGlassRef`. This
                             * covers the seconds before its model has loaded,
                             * so the pane is placed roughly rather than sitting
                             * in the middle of the frame.
                             */
                            if (!meshPlacesGlassRef.current) {
                                glass.style.setProperty(
                                    '--live-glass-cx',
                                    face_.cx.toFixed(3),
                                );
                                glass.style.setProperty(
                                    '--live-glass-cy',
                                    face_.cy.toFixed(3),
                                );
                                /*
                                 * Wider than the skin measure finds, because a
                                 * head is not skin all the way to its edge —
                                 * hair, ears and jaw shadow all read as
                                 * background to a chroma test. Bounded at both
                                 * ends: this is an ESTIMATE, and the floor
                                 * stops the pane collapsing to a dot on a bad
                                 * read while the cap stops it swallowing the
                                 * frame when something skin-coloured fills the
                                 * background.
                                 */
                                const rx = Math.min(
                                    0.42,
                                    Math.max(0.22, face_.faceWidth * 0.7),
                                );
                                glass.style.setProperty(
                                    '--live-glass-rx',
                                    rx.toFixed(3),
                                );
                                // Taller than wide, because a head is.
                                glass.style.setProperty(
                                    '--live-glass-ry',
                                    (rx * 1.3).toFixed(3),
                                );
                            }

                            // Reported on the same clock it was measured on —
                            // the caller needs no loop of its own.
                            faceMetricsRef.current?.({
                                faceWidth: face_.faceWidth,
                                cx: face_.cx,
                                cy: face_.cy,
                            });
                        }
                        /*
                         * No face found leaves the last values in place rather
                         * than snapping the hole back to the middle. A
                         * momentary miss — a turn, a hand across the lens —
                         * should not make the pane jump.
                         */
                    }
                } catch {
                    // A tainted or not-yet-ready frame. The pane keeps whatever
                    // it had, which is always a usable value.
                }
            }


            /*
             * ── Which pane can this browser actually draw? ──────────────────
             *
             * The stream is offered to the copy; whether the copy DECODES it is
             * the whole question. Chromium does and the `filter` version works;
             * WebKit will not put one camera into two video elements, so
             * `videoWidth` stays 0 forever and the `backdrop-filter` version is
             * the one that renders there.
             *
             * ⚠️ Probed rather than sniffed. A user-agent string is a guess at
             * a capability; this is the capability. It also cannot rot when a
             * browser gains or loses it.
             *
             * `GLASS_PROBE_MS` is a grace period, not a timeout to tune: a
             * decode that has not produced a single frame in that long is not
             * slow, it is not happening.
             */
            const glassCopy = glassCopyRef.current;
            if (glassCopy && video?.srcObject && !glassModeRef.current) {
                if (glassCopy.srcObject !== video.srcObject) {
                    glassCopy.srcObject = video.srcObject;
                    glassProbeAtRef.current = tick;
                    void glassCopy.play().catch(() => {
                        // An autoplay refusal answers the question early.
                        glassModeRef.current = 'pane';
                    });
                } else if (glassCopy.videoWidth > 0) {
                    glassModeRef.current = 'copy';
                } else if (tick - glassProbeAtRef.current > GLASS_PROBE_MS) {
                    glassModeRef.current = 'pane';
                    // Nothing is going to play into it; stop holding a decode
                    // open for an element that will never show anything.
                    glassCopy.srcObject = null;
                }

                if (glassModeRef.current && frameRef.current) {
                    frameRef.current.dataset.glass = glassModeRef.current;
                    console.log(`[glass] using the ${glassModeRef.current} pane`);
                }
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
            /*
             * The match bar. Same document fallback as every other probe here:
             * the detector mounts parts of itself outside the subtree it was
             * rendered into.
             */
            const barEl = (frameRef.current ?? document).querySelector(
                '.amplify-liveness-match-indicator__bar',
            );
            if (barEl) {
                if (!sawBarRef.current) {
                    sawBarRef.current = true;
                    // AWS has its model and is measuring. Ours may load now.
                    if (CAPTURE_PORTRAIT.enabled) kickstartSegmenter();
                }
                const now = Number(barEl.getAttribute('aria-valuenow'));
                // `aria-valuenow` is 0..100 and absent between states. A bad
                // read keeps the last value rather than dropping the gauge to
                // zero, which would flash the mesh back to white.
                if (Number.isFinite(now)) {
                    matchRef.current = Math.min(1, Math.max(0, now / 100));
                }
            }

            /*
             * The hint's VISIBLE text. The toast also carries a
             * visually-hidden live-region copy with different wording, so
             * `textContent` on the container would concatenate both — the
             * labelled div is the one on screen.
             */
            const hintEl = (frameRef.current ?? document).querySelector(
                '.amplify-liveness-toast__message div[aria-label]',
            );
            const hint = hintEl?.textContent?.trim() ?? '';

            /*
             * ── The CAMERA's zoom ───────────────────────────────────────────
             *
             * Unlike the display zoom (§11c, off), this moves AWS's bar: it
             * narrows the field of view, so the face occupies more of the
             * stream while the oval — derived from `videoWidth` — stays the
             * same size. See `CAPTURE_CAMERA_ZOOM` for why that is legitimate
             * and where the line is.
             *
             * ⚠️ IT LIVES HERE, in the poll, and not in the mesh's callback.
             * It is driven entirely by AWS's bar, which is read two lines up,
             * and it must keep working when the face-mesh model fails to load
             * or is switched off — the zoom is an ACCESSIBILITY aid and the
             * mesh is decoration. Hanging one off the other was the first
             * version and it also meant the zoom stopped whenever the mesh lost
             * the face, which is exactly when somebody is furthest away.
             */
            /*
             * ⚠️ NOT UNTIL AWS IS ACTUALLY MEASURING.
             *
             * `bar` is null until the detector reaches `ovalMatching`, which is
             * after the camera has opened, the socket has connected and
             * recording has started. Before that `matchRef` is still 0 — and a
             * loop that reads "bar is 0, zoom in" against a bar that does not
             * exist yet ramps straight to the camera's maximum the moment the
             * preview appears, in silence, before anybody has been asked to do
             * anything. Reported as exactly that: it zoomed on opening.
             *
             * Gating on the ELEMENT rather than on the value is what
             * distinguishes "no match yet" from "not being measured yet". They
             * are the same number and completely different situations.
             */
            /*
             * ⚠️ `sawBarRef`, NOT `bar`. Before the bar has ever appeared AWS
             * is not measuring anything and the loop must not run — reading
             * "bar is 0, zoom in" against a bar that does not exist yet ramps
             * straight to the camera's maximum the moment the preview opens.
             *
             * But once it HAS appeared, its later absence means the opposite:
             * the match phase is over. Gating on the live element conflated the
             * two, and the cost was the release never firing at "hold still" —
             * the bar unmounts at precisely that moment.
             */
            if (CAPTURE_CAMERA_ZOOM.enabled && video && sawBarRef.current) {
                const track =
                    (video.srcObject as MediaStream | null)?.getVideoTracks?.()?.[0] ??
                    null;
                if (track) {
                    const z = zoomRef.current;

                    /*
                     * Capability probed ONCE. Most laptop webcams do not expose
                     * `zoom` at all, and asking every tick would be a wasted
                     * call on exactly the hardware that cannot use the answer.
                     */
                    if (!z.checked) {
                        z.checked = true;
                        zoomTrackRef.current = track;
                        const caps = (
                            track.getCapabilities?.() as { zoom?: ZoomRange } | undefined
                        )?.zoom;
                        // A range with no room in it is not a zoom.
                        z.range = caps && caps.max > caps.min ? caps : null;
                        if (z.range) {
                            const settings = track.getSettings() as { zoom?: number };
                            z.value = settings.zoom ?? z.range.min;
                            z.desired = z.value;
                        } else {
                            console.log(
                                '[zoom] camera exposes no zoom capability — leaving it alone',
                            );
                        }
                    }

                    const range = z.range;
                    /*
                     * A request that never settles would hold `busy` raised for
                     * ever and stop the controller dead — including the
                     * release. See `ZOOM_STALL_MS`.
                     */
                    if (z.busy && tick - z.at > ZOOM_STALL_MS) z.busy = false;

                    if (range && !z.busy && tick - z.at >= CAPTURE_CAMERA_ZOOM.stepMs) {
                        const bar = matchRef.current;
                        const { closer, away, hold, gone } = hintTextRef.current;
                        const ceiling = Math.min(
                            range.max,
                            range.min * CAPTURE_CAMERA_ZOOM.max,
                        );
                        const clamp = (v: number) =>
                            Math.min(Math.max(v, range.min), ceiling);
                        const flip = () => {
                            z.dir = z.dir === 1 ? -1 : 1;
                        };

                        /*
                         * ── Has the match locked? ───────────────────────────
                         *
                         * Two signals, because the bar alone misses a case. The
                         * SDK returns MATCHED from either the IoU clearing its
                         * threshold OR `isFaceMatchedClosely`, and only the
                         * first drives the percentage to 100 — so somebody who
                         * arrives by the second route locks with the bar still
                         * short, and a release waiting on `lockAt` never comes.
                         * The "hold still" hint catches that; `holdAt` keeps it
                         * from firing on the same string shown much earlier,
                         * when a face is merely detected.
                         */
                        /*
                         * Three signals, in descending order of certainty.
                         *
                         *   the bar is GONE   the SDK has left `ovalMatching`
                         *                     entirely. Nothing is being
                         *                     measured any more, so whatever
                         *                     happened, the matching is over.
                         *   the bar is full   the IoU cleared its threshold.
                         *   "hold still"      `isFaceMatchedClosely` can return
                         *                     MATCHED without the percentage
                         *                     ever reaching 100, so the bar
                         *                     alone misses that route in.
                         *                     `holdAt` keeps this from firing
                         *                     on the same string shown much
                         *                     earlier, when a face is merely
                         *                     detected.
                         */
                        const locked =
                            !barEl ||
                            bar >= CAPTURE_CAMERA_ZOOM.lockAt ||
                            (!!hold &&
                                hint === hold &&
                                bar >= CAPTURE_CAMERA_ZOOM.holdAt);

                        /*
                         * ── Is there anybody there? ─────────────────────────
                         *
                         * Two signals again, for the same reason as the lock.
                         * AWS's "no face" hint is the explicit one, but the
                         * toast can simply go quiet when somebody walks off —
                         * so the mesh's own silence is the backstop, and it is
                         * the more reliable of the two.
                         */
                        const faceGone =
                            (!!gone && hint === gone) ||
                            (faceSeenAtRef.current > 0 &&
                                tick - faceSeenAtRef.current > FACE_LOST_MS);

                        /*
                         * ⚠️ LOCKED IS TESTED FIRST. The freshness sequence
                         * flashes full-screen colour over the face, and the
                         * mesh loses it while that happens — so a face-lost
                         * check ahead of this one would fire mid-release and
                         * drag the zoom to 1x at the exact moment the framing
                         * was being settled for the capture.
                         */
                        if (locked) {
                            /*
                             * Ease back toward `releaseTo` — see `lockAt` for
                             * why this window is safe, and `releaseTo` for why
                             * it is not all the way to 1x.
                             *
                             * The target is fixed at the moment of lock. Taken
                             * from the current value each tick it would be a
                             * fraction of a number already falling, and the
                             * pull-back would converge short of where it aimed.
                             */
                            if (z.target === null) {
                                /*
                                 * Half the ZOOM, not half the distance above
                                 * the minimum: 6x goes to 3x. Fixed at the
                                 * moment of lock, because taken from a value
                                 * that is already falling it would chase itself
                                 * and stop short.
                                 */
                                z.target = Math.max(
                                    range.min,
                                    z.desired * CAPTURE_CAMERA_ZOOM.releaseTo,
                                );
                                console.log(
                                    `[zoom] match locked at ${(z.desired / range.min).toFixed(2)}x — easing to ${(z.target / range.min).toFixed(2)}x`,
                                );
                            }
                            z.desired = Math.max(
                                z.target,
                                z.desired / (1 + CAPTURE_CAMERA_ZOOM.maxStep),
                            );
                        } else if (faceGone) {
                            /*
                             * Nobody in front of the camera. Go home.
                             *
                             * A zoom left in on an empty frame is worse than
                             * pointless: whoever arrives next walks into a
                             * cropped view of wherever the last person's head
                             * was, and the loop then has to unwind that before
                             * it can do anything useful. Unwinding it now, while
                             * there is nothing to look at, costs nothing.
                             */
                            /*
                             * Back to 1x, and the CONTROLLER goes back to its
                             * starting state with it. Easing the number home
                             * while leaving `released` set or a stale `target`
                             * in place would mean the next person to sit down
                             * is handled by a loop that still thinks the last
                             * check was finishing — it would refuse to zoom for
                             * them at all.
                             */
                            z.target = null;
                            z.released = false;
                            z.dir = 1;
                            z.lastBar = -1;
                            z.desired = Math.max(
                                range.min,
                                z.desired / (1 + CAPTURE_CAMERA_ZOOM.maxStep),
                            );
                        } else {
                            // Back under live control — a face returned, or the
                            // match came undone before recording finished.
                            z.target = null;

                            /*
                             * ── Follow AWS, then feel for the rest ──────────
                             *
                             * When the SDK says "closer" or "away" it has
                             * decided something about distance and the camera
                             * does as it is told. Overruling that with our own
                             * reading of the bar is how a zoom ends up pulling
                             * against the sentence on screen — the failure the
                             * DISPLAY zoom was turned off for.
                             *
                             * When it says anything else, the bar is the only
                             * signal, and this hill climbs: keep going the way
                             * that helped, turn around when it stops helping.
                             */
                            if (!!closer && hint === closer) z.dir = 1;
                            else if (!!away && hint === away) z.dir = -1;
                            else if (
                                z.lastBar >= 0 &&
                                bar < z.lastBar - CAPTURE_CAMERA_ZOOM.backOff
                            ) {
                                flip();
                            }

                            const next =
                                z.dir === 1
                                    ? z.desired * (1 + CAPTURE_CAMERA_ZOOM.maxStep)
                                    : z.desired / (1 + CAPTURE_CAMERA_ZOOM.maxStep);
                            /*
                             * Hitting either end turns the loop around. Left to
                             * itself it would keep asking for a value the clamp
                             * rejects, the applied zoom would never change, and
                             * it would sit at the stop doing nothing.
                             */
                            if (clamp(next) !== next) flip();
                            z.desired = clamp(next);
                        }

                        z.desired = clamp(z.desired);
                        z.lastBar = bar;

                        /*
                         * ⚠️ ROUNDED TO THE DEVICE'S GRID ONLY HERE.
                         *
                         * `desired` moves by a fixed proportion every tick
                         * regardless of what the camera can express; this is
                         * where that intent meets the hardware. Several small
                         * intents accumulate until the rounded value actually
                         * changes, so a coarse camera moves as smoothly as it
                         * is able and is never handed a forced jump to make
                         * something happen.
                         */
                        const grid = range.step || 0.01;
                        const want = clamp(
                            range.min +
                                Math.round((z.desired - range.min) / grid) * grid,
                        );

                        if (Math.abs(want - z.value) >= grid * 0.5) {
                            z.at = tick;
                            z.busy = true;
                            const applied = want;
                            void track
                                .applyConstraints({
                                    advanced: [
                                        { zoom: applied } as MediaTrackConstraintSet,
                                    ],
                                })
                                .then(() => {
                                    z.busy = false;
                                    z.value = applied;
                                    // One line per adjustment. The zoom is the
                                    // only thing on this screen that moves
                                    // without the person doing anything, so
                                    // when it misbehaves this is the only way
                                    // to see what it thought it was doing.
                                    // Only when the phase CHANGES — see `said`.
                                    const phase = locked
                                        ? 'release'
                                        : faceGone
                                          ? 'reset'
                                          : z.dir > 0
                                            ? 'in'
                                            : 'out';
                                    if (phase !== z.said) {
                                        z.said = phase;
                                        console.log(
                                            `[zoom] ${phase} — ${(applied / range.min).toFixed(2)}x, bar ${(bar * 100) | 0}%`,
                                        );
                                    }
                                })
                                .catch(() => {
                                    z.busy = false;
                                    /*
                                     * Some cameras advertise `zoom` and then
                                     * refuse it. Give up for the rest of the
                                     * check rather than retrying against a
                                     * device that has already said no.
                                     */
                                    z.range = null;
                                    console.log(
                                        '[zoom] camera refused applyConstraints — giving up',
                                    );
                                });
                        }

                        if (locked && !z.released) {
                            z.released = true;
                            bestFrame.current = null;
                        }
                    }
                }
            }

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

                /*
                 * ── Get something on screen NOW ─────────────────────────────
                 *
                 * Before `processFrame`, before anything async. The camera is
                 * already black at this point and every overlay drawn over the
                 * live preview is now drawn over nothing.
                 *
                 * The raw frame is encoded synchronously — a JPEG of an
                 * already-decoded canvas, tens of milliseconds — and handed
                 * straight over. The processed version follows and replaces it.
                 */
                if (frameRef.current) frameRef.current.dataset.stream = 'ended';
                try {
                    const raw = bestFrame.current?.canvas;
                    streamStoppedRef.current?.(
                        raw?.width ? raw.toDataURL('image/jpeg', 0.85) : null,
                    );
                } catch {
                    // A tainted canvas cannot be encoded. The processed handover
                    // below is unaffected; this was only the earlier of the two.
                    streamStoppedRef.current?.(null);
                }
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
                    {/*
                      TWO PANES, one shown. Which technique this browser can
                      actually draw is probed at runtime and answered on
                      `data-glass`; see `.rz-live-glass` in liveness.css and the
                      probe in the sampling loop. Both are hidden until the
                      probe decides, so an engine that can do both never stacks
                      them.
                    */}
                    <video
                        ref={glassCopyRef}
                        aria-hidden
                        playsInline
                        muted
                        className={`rz-live-glass rz-live-glass--copy ${MIRROR_CLASS}`}
                        style={GLASS_VARS}
                    />
                    <span
                        ref={glassVideoRef}
                        aria-hidden
                        className="rz-live-glass rz-live-glass--pane"
                        style={GLASS_VARS}
                    />
                </>
            )}

            {/* The mesh. After the glass so it draws over it — the tracery is
                on the FACE, which is the one part the glass deliberately leaves
                clear, so putting it under the pane would hide it exactly where
                it is meant to be. */}
            {CAPTURE_LIVE_MESH.enabled && (
                <FaceMesh
                    videoRef={videoElRef}
                    canvasRef={meshCanvasRef}
                    matchRef={matchRef}
                    onBounds={handleMeshBounds}
                />
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

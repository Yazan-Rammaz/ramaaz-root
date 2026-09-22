'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

import { TFJS_WASM_PATH, blazefaceModelUrl } from '@/features/kyc/config/liveness';
import { CAPTURE_PORTRAIT, CAPTURE_RESOLUTION } from '@/features/kyc/config/capture';
import { useLivePreview } from '@/features/kyc/hooks/useLivePreview';
import { scoreFrameQuality } from '@/features/kyc/services/imageQuality';
import {
    frameHasContent,
    grabFrame,
    processFrame,
    type FaceCapture,
} from '@/features/kyc/services/faceCapture';
import { kickstartSegmenter } from '@/features/kyc/services/portrait';
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
        // Follows the same switch the capture does, so the preview and the
        // photograph cannot disagree about whether the room is defocused.
        portrait: CAPTURE_PORTRAIT.enabled,
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
     * It is ~250KB and the capture happens the instant the stream ends, so
     * fetching it then would add a visible stall between the last frame and the
     * verdict — on the one screen where a pause reads as a problem. Fails soft:
     * `applyPortrait` returns the original photograph when the model never
     * arrives.
     */
    useEffect(() => {
        if (CAPTURE_PORTRAIT.enabled) kickstartSegmenter();
    }, []);

    useEffect(() => {
        const id = setInterval(() => {
            const video = frameRef.current?.querySelector('video');
            if (!video?.videoWidth) return;
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

'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

import { TFJS_WASM_PATH, blazefaceModelUrl } from '@/features/kyc/config/liveness';
import { scoreFrameQuality } from '@/features/kyc/services/imageQuality';
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
 * 0.92, not the 0.85 this shipped with.
 *
 * The only argument for a lower number is payload size, and the difference is a
 * few tens of kilobytes on a frame posted once. What it costs is real: JPEG
 * artefacts land hardest on the mid-frequency detail — eye corners, the edge of
 * the nose — that CompareFaces reads at `face-match`.
 */
const SNAPSHOT_JPEG_QUALITY = 0.92;

/** The camera frame's shape, 350x400 — what the capture is cropped to. */
const FRAME_ASPECT = 350 / 400;

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
     * `snapshot` is the last camera frame as a data URL, for the screen to show
     * while the servers decide. It is purely presentational: AWS picks the
     * image it actually judges from the stream, server-side, and the browser
     * never sees that one. Null if the frame could not be grabbed.
     */
    onAnalysisComplete: (snapshot: string | null) => Promise<void>;
    onError: (error: { state?: string; error?: Error }) => void;
}) {
    const t = useTranslations('auth');
    const frameRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        const id = setInterval(() => {
            const video = frameRef.current?.querySelector('video');
            if (!video?.videoWidth) return;

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
             * Cropped to the frame's shape, centred — the same crop
             * `object-fit: cover` performs on screen.
             *
             * Keeping the whole sensor frame files a landscape photograph for a
             * portrait flow, and then every place that shows it crops it again
             * to something slightly different. Capturing what the user was
             * looking at is the only version that cannot disagree with the
             * preview.
             */
            const sw = video.videoWidth;
            const sh = video.videoHeight;
            const cropW = Math.min(sw, sh * FRAME_ASPECT);
            const cropH = Math.min(sh, sw / FRAME_ASPECT);

            const canvas = held?.canvas ?? document.createElement('canvas');
            if (canvas.width !== Math.round(cropW)) {
                canvas.width = Math.round(cropW);
                canvas.height = Math.round(cropH);
            }
            try {
                canvas
                    .getContext('2d')
                    ?.drawImage(
                        video,
                        (sw - cropW) / 2,
                        (sh - cropH) / 2,
                        cropW,
                        cropH,
                        0,
                        0,
                        canvas.width,
                        canvas.height,
                    );
                bestFrame.current = {
                    canvas,
                    sharpness: score?.sharpness ?? 0,
                    at: Date.now(),
                };
            } catch {
                // A tainted canvas would throw. Same-origin stream, so it should
                // not — and a missing still must never break the check.
            }
        }, FRAME_POLL_MS);
        return () => clearInterval(id);
    }, []);

    return (
        <div ref={frameRef} className="rz-liveness absolute inset-0">
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
                    onAnalysisComplete={() => {
                        /*
                         * The frame as the camera gave it, encoded once.
                         *
                         * A background-blur and relighting pipeline used to sit
                         * here. It is gone: every version of it that looked
                         * right in one situation looked wrong in another, and a
                         * photograph of a real person for a real identity record
                         * is a poor place to keep guessing. `git log` has it if
                         * it is ever wanted back.
                         */
                        const canvas = bestFrame.current?.canvas;
                        return onAnalysisComplete(
                            canvas?.width
                                ? canvas.toDataURL('image/jpeg', SNAPSHOT_JPEG_QUALITY)
                                : null,
                        );
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

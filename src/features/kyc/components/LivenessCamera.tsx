'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

import { TFJS_WASM_PATH, blazefaceModelUrl } from '@/features/kyc/config/liveness';
import { FaceMeshOverlay } from './FaceMeshOverlay';
import './liveness.css';

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
             * canvas's surround fill — but that canvas is hidden outright now
             * (see liveness.css), so nothing painted into it is visible and this
             * value no longer decides anything on screen.
             */
            background: { primary: { value: '#000000' } },
            font: { primary: { value: '#FFFFFF' }, inverse: { value: '#FFFFFF' } },
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
     * Freeze the last frame before AWS disposes of its video element.
     *
     * It has to happen inside `onAnalysisComplete` and synchronously: the widget
     * tears down as soon as the stream ends, and a frame grabbed one tick later
     * is grabbed from an element that is already gone.
     */
    const grabSnapshot = (): string | null => {
        const video = frameRef.current?.querySelector('video');
        if (!video?.videoWidth) return null;
        try {
            const shot = document.createElement('canvas');
            shot.width = video.videoWidth;
            shot.height = video.videoHeight;
            const ctx = shot.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(video, 0, 0);
            // JPEG, not PNG: this is a photograph, and a PNG of a camera frame
            // is several megabytes of base64 held in React state.
            return shot.toDataURL('image/jpeg', 0.85);
        } catch {
            // A tainted canvas would throw. The stream is same-origin so it
            // should not — and a missing still must never fail the check.
            return null;
        }
    };

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
                    onAnalysisComplete={() => onAnalysisComplete(grabSnapshot())}
                    onError={onError}
                />
            </ThemeProvider>

            {/* Outside the ThemeProvider and after the widget on purpose: it is
                a sibling that paints over AWS's camera and touches nothing of
                theirs. Delete this line and the check is unchanged. */}
            <FaceMeshOverlay containerRef={frameRef} />
        </div>
    );
}

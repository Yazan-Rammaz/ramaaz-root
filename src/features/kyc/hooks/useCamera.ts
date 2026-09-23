'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { CAPTURE_MIRROR } from '@/features/kyc/config/capture';

interface UseCameraOptions {
    /** Desired facing mode. On desktop, 'environment' is automatically overridden to 'user'. */
    facingMode: 'user' | 'environment';
    width?: number;
    height?: number;
    /**
     * Preferred stream aspect ratio (width / height). Pass the ratio of the
     * frame the video is rendered into — e.g. `350 / 400` for the 350x400
     * viewfinders — so the camera produces that shape and `object-cover` has
     * nothing left to crop. Omitted means "whatever the camera prefers", which
     * is right for ID capture: the card is landscape, so a wide stream spends
     * more pixels on it. See the note at the getUserMedia call.
     */
    aspectRatio?: number;
}

interface UseCameraReturn {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    isActive: boolean;
    error: string | null;
    /**
     * Whether the video preview should be CSS-mirrored (scaleX(-1)).
     * True when 'user' was REQUESTED — a self-view — on any device.
     * False when 'environment' was requested, on any device, including a
     * desktop that has to open the webcam to serve it. See the note at the
     * assignment: mirroring follows the intent, not which camera opened.
     *
     * The captured frame is ALWAYS the raw, non-mirrored image regardless of
     * this flag — ctx.drawImage() reads native pixel data, not CSS transforms.
     */
    shouldMirror: boolean;
    startCamera: () => Promise<void>;
    stopCamera: () => void;
    captureFrame: () => string | null;
}

/**
 * Returns true when running on a touch-capable mobile/tablet device.
 * Checked once per hook call; safe to call on the server (returns false).
 */
function isMobileDevice(): boolean {
    if (typeof navigator === 'undefined') return false;
    return (
        navigator.maxTouchPoints > 1 || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
}

export function useCamera({
    facingMode: requestedFacing,
    width = 1500,
    height = 900,
    aspectRatio,
}: UseCameraOptions): UseCameraReturn {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [isActive, setIsActive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isMobile = isMobileDevice();

    /*
      NOTHING MIRRORS ANY MORE, by request (2026-09-22).

      This read `requestedFacing === 'user'` — mirror the self-view, never the
      document. The self-view half of that is gone: every face screen now shows
      the camera's own pixels, the same ones the capture keeps and the same ones
      every later screen displays. One orientation everywhere, so a face cannot
      flip between the preview, the still and the comparison.

      What that costs, stated plainly because it is the reason it was ever true:
      a mirror is the natural self-view. You move left, the image moves left,
      which is how a person lines their own face up. Unmirrored, that is
      reversed, and centring takes a moment longer. The face gate tolerates it —
      it measures the stream, not the viewer's intuition — but somebody
      struggling to centre on a laptop is now an expected complaint rather than
      a surprising one.

      The DOCUMENT half was never in question: a mirrored card reads backwards
      and people try to "fix" it by turning it over. That is now simply the
      universal behaviour rather than a special case.

      Kept as a named constant rather than deleted. Callers still read it — the
      ID scanner overlay and corner brackets follow it so they stay in step with
      the preview — and one `false` here is a smaller, more reversible change
      than unpicking it from every call site.

      The captured frame was never affected either way: `captureFrame` reads
      native pixels through `drawImage`, not CSS transforms.
    */
    const shouldMirror = CAPTURE_MIRROR.enabled && requestedFacing === 'user';

    const effectiveFacing: 'user' | 'environment' = !isMobile ? 'user' : requestedFacing;

    const stopCamera = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        setIsActive(false);
    }, []);

    const startCamera = useCallback(async () => {
        setError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: effectiveFacing,
                    width: { ideal: width },
                    height: { ideal: height },
                    /*
                      Ask the CAMERA for the shape the frame actually is, rather
                      than cropping a landscape stream down to it afterwards.

                      Every frame these screens render into is 350 x 400 — a
                      portrait 0.875 — but the request above asks for 1500 x 900,
                      a landscape 1.67. `object-cover` then has to discard about
                      48% of the width to fit, which is why a face here fills the
                      frame far more tightly, and reads as taller and narrower,
                      than the same face in the phone's own camera app: it is a
                      heavy centre crop of a wide picture, not a portrait one.

                      Asking at the source is the fix PhoneCamera already uses
                      for the hand-off (`aspectRatio: { ideal: 350 / 400 }`), and
                      this is the same constraint for the same reason. The
                      browser then hands back a stream already shaped like the
                      frame, `object-cover` has almost nothing left to trim, and
                      the proportions match what the user expects.

                      `ideal`, not `exact`: a camera that cannot produce this
                      ratio must still return SOMETHING. `exact` would make
                      getUserMedia reject with OverconstrainedError and the
                      screen would show a dead frame rather than a cropped one.

                      Callers that want a different shape pass their own — ID
                      capture deliberately does NOT use this, because the card is
                      landscape and a portrait stream spends fewer pixels on it,
                      which costs OCR accuracy and makes `minAreaRatio` harder.
                    */
                    ...(aspectRatio ? { aspectRatio: { ideal: aspectRatio } } : {}),
                },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setIsActive(true);
        } catch (err) {
            const message =
                err instanceof DOMException && err.name === 'NotAllowedError'
                    ? 'Camera permission denied. Please allow camera access in your browser settings.'
                    : 'Failed to access camera. Please check your device.';
            setError(message);
            setIsActive(false);
        }
    }, [effectiveFacing, width, height, aspectRatio]);

    /**
     * Captures the current video frame to a JPEG data URL.
     * Uses ctx.drawImage() which reads raw pixel data — CSS transforms (including
     * the mirror scaleX(-1)) have no effect on the captured image.  The result
     * is always the correctly-oriented frame suitable for OCR and face matching.
     */
    const captureFrame = useCallback((): string | null => {
        if (!videoRef.current || !canvasRef.current) return null;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0);
        // 0.92, not 0.8. This frame is read by Textract or by CompareFaces, and
        // JPEG artefacts fall on the mid-frequency detail both of them depend
        // on — small print on a card, the corner of an eye. The extra bytes are
        // nothing against a capture that has to be retaken.
        return canvas.toDataURL('image/jpeg', 0.92);
    }, []);

    useEffect(() => {
        return () => {
            stopCamera();
        };
    }, [stopCamera]);

    return {
        videoRef,
        canvasRef,
        isActive,
        error,
        shouldMirror,
        startCamera,
        stopCamera,
        captureFrame,
    };
}

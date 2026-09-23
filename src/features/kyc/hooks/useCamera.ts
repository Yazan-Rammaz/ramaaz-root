'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { CAPTURE_MIRROR } from '@/features/kyc/config/capture';
import { isShimInstalled } from '@/features/kyc/handoff/cameraShim';

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
      A SELF-VIEW MIRRORS. THE QUESTION IS WHAT COUNTS AS ONE.

      The rule everybody reaches for is "mirror the face, never the document",
      and it is written in terms of the wrong thing — the REQUEST. A document
      asks for `environment`; a laptop does not have one; `effectiveFacing`
      opens the front camera instead and says nothing about it. The request
      still reads "document", so the preview stayed raw on a lens pointed
      squarely at the user: move the card to your right and it travels left,
      which is the one thing nobody can align against.

      So the decision moved to `openFacing` below, which asks the TRACK what
      opened rather than asking the caller what it wanted. A camera pointed at
      you is a self-view no matter which step is using it.

      ⚠️ WHAT THAT COSTS, and it is a real cost: a mirrored card reads
      backwards. People try to "fix" that by turning the card over, which is
      why the document half of the old rule existed at all. It is the trade the
      reversed movement is worth — and only the PREVIEW is affected. What the
      scanner reads, what OCR is given and what is stored are all the raw
      frame: `captureFrame` goes through `drawImage`, which ignores CSS
      transforms entirely.

      Callers follow this flag rather than re-deriving it — the ID scanner
      overlay and the corner brackets are drawn from raw-frame coordinates and
      flip with the preview, so they stay on the card either way.
    */

    /**
     * What the OPEN CAMERA turns out to be, decided once the stream exists.
     *
     * ── Why the requested facing is the wrong thing to ask ──────────────────
     * A document asks for `environment`, and on a laptop there is no such
     * camera — `effectiveFacing` quietly opens the front one instead. So the
     * ID screen ran unmirrored on a webcam that is physically pointed at the
     * user, and the user's own right came out on the left: move the card right,
     * it travels left. Nobody can align a card against that, and it is not a
     * document-camera problem at all — it is a self-view wearing a document
     * camera's request.
     *
     * The honest question is which way the lens is pointing, and the only thing
     * that knows is the track.
     *
     * ⚠️ THE PHONE PATHS MUST NOT MOVE, and both are covered by their own
     * clause rather than by luck:
     *
     *   hand-off      the picture is a phone's REAR camera relayed in over
     *                 WebRTC. The desktop running it is not mobile and the
     *                 track reports no facing mode, so it looks exactly like a
     *                 laptop webcam from here — `isShimInstalled()` is the only
     *                 thing that tells them apart.
     *   phone direct  /login/identity opened on the handset. `environment` is
     *                 requested AND granted, so the track says so.
     *
     * Null until a stream is open, and the fallback below is the old rule, so
     * nothing changes in the window before the camera answers.
     */
    const [openFacing, setOpenFacing] = useState<'user' | 'environment' | null>(null);

    const shouldMirror =
        CAPTURE_MIRROR.enabled &&
        (openFacing === null ? requestedFacing === 'user' : openFacing === 'user');

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

            /*
             * Which way is this lens actually pointing? See `openFacing`.
             *
             * Order matters, and each line is the only thing that can answer
             * its case:
             *
             *   1. A relayed hand-off track reports nothing about itself, so
             *      the REQUEST is the best evidence there is — and it is good
             *      evidence: the phone was handed that facing in its own URL
             *      (`useCameraHandoff` puts `?c=` on it) and opened the camera
             *      it was asked for. A face step relays the phone's FRONT
             *      camera and must still mirror; an ID step relays the rear one
             *      and must not. Deciding by the shim alone would have
             *      un-mirrored the face hand-off, which is not a case this
             *      change is allowed to touch.
             *   2. A real rear camera says `environment` — a phone that granted
             *      what a document asked for.
             *   3. Anything else is pointed at whoever is sitting in front of
             *      it. That covers a laptop webcam serving a document request,
             *      which is the case this exists for, and it is why the test is
             *      "not environment" rather than "is user": desktop webcams
             *      routinely report no facing mode at all, and treating silence
             *      as a rear camera is what produced the reversed preview.
             */
            const settings = stream.getVideoTracks()[0]?.getSettings();
            setOpenFacing(
                isShimInstalled()
                    ? requestedFacing
                    : settings?.facingMode === 'environment'
                      ? 'environment'
                      : 'user',
            );

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
    }, [effectiveFacing, requestedFacing, width, height, aspectRatio]);

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

'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

interface UseCameraOptions {
    /** Desired facing mode. On desktop, 'environment' is automatically overridden to 'user'. */
    facingMode: 'user' | 'environment';
    width?: number;
    height?: number;
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
}: UseCameraOptions): UseCameraReturn {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [isActive, setIsActive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isMobile = isMobileDevice();

    /*
      Mirroring follows the INTENT, not the hardware.

      A mirror is right for a SELF-view: you move left, the image moves left,
      which is the only way a person can line their own face up. It is wrong for
      a DOCUMENT: the card comes out flipped and every word on it reads
      backwards, so the user sees an ID that looks like the wrong side, held the
      wrong way round, and tries to "fix" it by turning the card over.

      This used to read `!isMobile ? true : ...` — mirror EVERYTHING on desktop.
      That was conflating two different questions. `effectiveFacing` below has
      to say 'user' on a laptop because a laptop has no back camera and asking
      for 'environment' gets you nothing; but which camera the hardware opens
      says nothing about whether the picture should be flipped for the viewer.
      The result was that the ID capture screen — which asks for 'environment'
      precisely because it is photographing a document — showed a mirrored,
      backwards card on every desktop.

      Keying on `requestedFacing` separates them: the two face screens ask for
      'user' and still mirror on every device, ID capture asks for
      'environment' and never mirrors on any. Nothing about this is
      locale-dependent — `scaleX(-1)` is a physical transform and `dir` cannot
      reach it.

      The captured frame was never affected either way: `captureFrame` reads
      native pixels through `drawImage`, not CSS transforms. The scanner overlay
      and corner brackets DO follow this flag, so they stay in step with
      whatever the preview is doing.
    */
    const shouldMirror = requestedFacing === 'user';

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
    }, [effectiveFacing, width, height]);

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
        return canvas.toDataURL('image/jpeg', 0.8);
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

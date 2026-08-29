'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    computeBrightness,
    computeMotion,
    computeSharpness,
    getDownsampledImageData,
} from '@/features/kyc/services/imageQuality';
import { estimateYaw, useFaceLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';

/**
 * The gate that decides when a frame is worth sending.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Nothing leaves the browser until there is genuinely a face in the frame, in
 * focus, well lit and holding still. Every frame sent to the KYC Worker costs a
 * real AWS Rekognition call, and — far more importantly — a dark, blurred or
 * empty frame produces a *failed* check, which the backend counts against a
 * challenge that only tolerates five failures in total. Sending an obviously
 * unusable frame spends one of somebody's five attempts on our own impatience.
 *
 * So the checks below are not UI polish. They are what stops the client
 * burning a sign-in it cannot get back.
 *
 * ── Why not `useFrameValidation` ────────────────────────────────────────────
 * That hook answers a different question. Its failure reasons are
 * `card_not_detected`, `wrong_shape`, `screen_detected` — it looks for a
 * rectangular document, and a face fails every one of them.
 *
 * ── The five checks ─────────────────────────────────────────────────────────
 * Face present · roughly centred · facing forward · well lit and sharp · still.
 * All five must hold CONTINUOUSLY for `stabilityMs`; a single bad sample resets
 * the clock. That is what makes the capture feel deliberate rather than
 * trigger-happy, and it is the same shape as the iOS Face ID hold.
 */

export type FaceGateReason =
    | 'model_loading'
    | 'no_face'
    | 'multiple_faces'
    | 'too_far'
    | 'too_close'
    | 'off_centre'
    | 'not_facing'
    | 'too_dark'
    | 'too_bright'
    | 'too_blurry'
    | 'moving';

export type FaceGateState = {
    /** Null until the first sample. */
    reason: FaceGateReason | null;
    /** All five checks passing on the latest sample. */
    pass: boolean;
    /** How long (ms) they have passed continuously. Resets to 0 on any miss. */
    stableDuration: number;
    /** 0..1 progress toward `stabilityMs` — drives the hold animation. */
    progress: number;
    /** True once the hold completes. Latches until `reset()`. */
    ready: boolean;
};

type Options = {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Pause sampling — while a capture is in flight, or the step is done. */
    paused?: boolean;
    /** How long every check must hold. iOS-ish; long enough to feel deliberate. */
    stabilityMs?: number;
};

/* Tuned against a laptop webcam at arm's length. Face box is measured as a
 * fraction of the FRAME, so these are resolution-independent. */
const MIN_FACE_RATIO = 0.16; // smaller than this and the face is too far away
const MAX_FACE_RATIO = 0.85; // larger and it is cropped by the frame edges
const MAX_CENTRE_OFFSET = 0.22; // of frame width/height, from dead centre
const MAX_YAW_DEG = 18; // beyond this they are looking away, not at us
const MIN_BRIGHTNESS = 55;
const MAX_BRIGHTNESS = 215;
const MIN_SHARPNESS = 8;
const MAX_MOTION = 6;
const SAMPLE_MS = 120;

export function useFaceGate({
    videoRef,
    paused = false,
    stabilityMs = 1200,
}: Options): FaceGateState & { reset: () => void } {
    const { isReady, detect } = useFaceLandmarker();

    const [state, setState] = useState<FaceGateState>({
        reason: null,
        pass: false,
        stableDuration: 0,
        progress: 0,
        ready: false,
    });

    const stableSince = useRef<number | null>(null);
    const prevFrame = useRef<ImageData | null>(null);
    const latched = useRef(false);

    const reset = useCallback(() => {
        latched.current = false;
        stableSince.current = null;
        prevFrame.current = null;
        setState({ reason: null, pass: false, stableDuration: 0, progress: 0, ready: false });
    }, []);

    useEffect(() => {
        if (paused) return;

        let raf = 0;
        let last = 0;
        let cancelled = false;

        const sample = (now: number) => {
            raf = requestAnimationFrame(sample);
            if (cancelled || now - last < SAMPLE_MS) return;
            last = now;

            const video = videoRef.current;
            if (!video || video.readyState < 2) return;
            if (latched.current) return;

            const fail = (reason: FaceGateReason) => {
                stableSince.current = null;
                setState((s) =>
                    s.reason === reason && !s.pass && s.stableDuration === 0
                        ? s // identical verdict — do not re-render, the text is being read
                        : { reason, pass: false, stableDuration: 0, progress: 0, ready: false },
                );
            };

            if (!isReady) return fail('model_loading');

            // ── 1. a face, and only one ───────────────────────────────────
            const result = detect(video);
            if (!result) return; // between frames; not a verdict
            const faces = result.faceLandmarks ?? [];
            if (faces.length === 0) return fail('no_face');
            if (faces.length > 1) return fail('multiple_faces');

            // ── 2. size and position, from the landmark bounding box ──────
            const pts = faces[0]!;
            let minX = 1;
            let minY = 1;
            let maxX = 0;
            let maxY = 0;
            for (const p of pts) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
            const w = maxX - minX;
            const h = maxY - minY;
            const ratio = Math.max(w, h);
            if (ratio < MIN_FACE_RATIO) return fail('too_far');
            if (ratio > MAX_FACE_RATIO) return fail('too_close');

            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            if (
                Math.abs(cx - 0.5) > MAX_CENTRE_OFFSET ||
                Math.abs(cy - 0.5) > MAX_CENTRE_OFFSET
            ) {
                return fail('off_centre');
            }

            // ── 3. facing the camera ──────────────────────────────────────
            const yaw = estimateYaw(result);
            if (yaw !== null && Math.abs(yaw) > MAX_YAW_DEG) return fail('not_facing');

            // ── 4 & 5. exposure, focus, stillness ─────────────────────────
            const img = getDownsampledImageData(video);
            if (!img) return;

            const brightness = computeBrightness(img);
            if (brightness < MIN_BRIGHTNESS) {
                prevFrame.current = img;
                return fail('too_dark');
            }
            if (brightness > MAX_BRIGHTNESS) {
                prevFrame.current = img;
                return fail('too_bright');
            }
            if (computeSharpness(img) < MIN_SHARPNESS) {
                prevFrame.current = img;
                return fail('too_blurry');
            }
            if (prevFrame.current && computeMotion(prevFrame.current, img) > MAX_MOTION) {
                prevFrame.current = img;
                return fail('moving');
            }
            prevFrame.current = img;

            // ── All five hold. Run the clock. ─────────────────────────────
            if (stableSince.current === null) stableSince.current = now;
            const held = now - stableSince.current;
            const done = held >= stabilityMs;
            if (done) latched.current = true;

            setState({
                reason: null,
                pass: true,
                stableDuration: held,
                progress: Math.min(1, held / stabilityMs),
                ready: done,
            });
        };

        raf = requestAnimationFrame(sample);
        return () => {
            cancelled = true;
            cancelAnimationFrame(raf);
        };
    }, [detect, isReady, paused, stabilityMs, videoRef]);

    return { ...state, reset };
}

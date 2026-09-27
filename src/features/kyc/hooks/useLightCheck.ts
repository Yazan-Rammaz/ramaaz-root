'use client';

import { useEffect, useRef, useState } from 'react';

import { faceLightConfig } from '@/features/kyc/config/kycConfig';
import { judgeFaceFrame, type FaceFrameVerdict } from '@/features/kyc/services/imageQuality';

export type LightCheckState = {
    /**
     * Latest reading. `null` before the first sample — the honest answer while
     * there is no stream yet, and distinct from any verdict about one.
     */
    verdict: FaceFrameVerdict | null;
    /**
     * True once the frame has been good CONTINUOUSLY for `stableMs`.
     *
     * ⚠️ DOES NOT LATCH. It goes false again the moment the light drops or the
     * picture softens, which is what makes this usable *during* a check and not
     * only in front of one.
     */
    ready: boolean;
    /** 0..1 through the hold. Drives the "hold it there" affordance. */
    progress: number;
};

type Options = {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Pause sampling — no stream yet, or this gate is done with. */
    paused?: boolean;
};

/**
 * Is this frame good enough to run a face check on — light, and focus?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * AWS Face Liveness decides in the cloud. In a dark room it does not refuse to
 * run: it opens, it records, it takes the photograph, it charges for the
 * session, it spends the backend's challenge validate — and only then comes
 * back with a refusal the person could have avoided by turning a lamp on. From
 * the inside that reads as "it took my photo and then said no", which is both
 * true and the worst possible shape for a sign-in step.
 *
 * The detector does show its own `hintIlluminationTooDarkText` mid-check, but
 * it says nothing about focus, and by the time it appears everything has
 * already been spent.
 *
 * ── It runs in TWO places, and that is the point ────────────────────────────
 * Measuring only before the camera opens would catch a dark room and miss
 * everything that happens next: somebody steps in front of a window, a light
 * clicks off, the phone is picked up and the lens loses focus. The same hook
 * runs against the live check too (see `LivenessCamera`), so the warning is
 * tied to the CURRENT frame rather than to a snapshot of the room taken before
 * anybody had raised their face to the camera.
 *
 * That is why nothing here latches. `ready` is a statement about right now.
 *
 * ── Why it reads the centre AND the frame ───────────────────────────────────
 * A single frame-wide reading cannot tell a dark room from a backlit one, and
 * those two need opposite instructions — see `judgeFaceFrame`, which owns every
 * rule this hook reports. The hook's only job is the hold, so that a verdict
 * has to persist before it is acted on.
 */
export function useLightCheck({ videoRef, paused = false }: Options): LightCheckState {
    const [state, setState] = useState<LightCheckState>({
        verdict: null,
        ready: false,
        progress: 0,
    });

    /** When the current unbroken run of good frames began. */
    const goodSince = useRef<number | null>(null);

    useEffect(() => {
        if (paused) {
            goodSince.current = null;
            return;
        }

        let raf = 0;
        let cancelled = false;
        let lastSample = 0;

        const tick = (now: number) => {
            if (cancelled) return;
            raf = requestAnimationFrame(tick);

            if (now - lastSample < faceLightConfig.sampleMs) return;
            lastSample = now;

            const video = videoRef.current;
            // readyState >= 2 (HAVE_CURRENT_DATA) means there is a frame to
            // read. Before that `drawImage` yields a blank canvas, which reads
            // as pitch black — the very verdict this hook is deciding.
            if (!video || video.readyState < 2) return;

            const reading = judgeFaceFrame(video, faceLightConfig);
            if (!reading) return;

            if (reading.verdict !== 'ok') {
                goodSince.current = null;
                setState((s) =>
                    // Same complaint as last time: leave the object alone so the
                    // message the person is reading does not re-render under
                    // them 150ms after it appeared.
                    s.verdict === reading.verdict && !s.ready && s.progress === 0
                        ? s
                        : { verdict: reading.verdict, ready: false, progress: 0 },
                );
                return;
            }

            goodSince.current ??= now;
            const progress = Math.min(1, (now - goodSince.current) / faceLightConfig.stableMs);
            setState((s) =>
                s.verdict === 'ok' && s.progress === progress && s.ready === progress >= 1
                    ? s
                    : { verdict: 'ok', ready: progress >= 1, progress },
            );
        };

        raf = requestAnimationFrame(tick);
        return () => {
            cancelled = true;
            cancelAnimationFrame(raf);
        };
    }, [paused, videoRef]);

    return state;
}

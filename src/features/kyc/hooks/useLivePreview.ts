'use client';

/**
 * The look, applied to the LIVE camera rather than only to the capture.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 * Draws each video frame into a canvas, runs the same `applyLook` the captured
 * still runs, and paints the result over the video. The video element stays in
 * the DOM and keeps decoding — it is only made transparent — so everything that
 * reads the camera keeps working untouched.
 *
 * ⚠️ IT DOES NOT AFFECT THE LIVENESS CHECK, AND MUST NOT. AWS streams the
 * MediaStream track to Rekognition and runs its face-fit test against the video
 * stream's own geometry; neither reads the pixels we paint on top. What the
 * user sees and what Amazon judges are deliberately different things here — the
 * check is performed on the unmodified camera, and the retouched frame exists
 * only on the screen. Anything that changes that is a security regression, not
 * a visual one.
 *
 * ── The real risk is not correctness, it is CPU ─────────────────────────────
 * This runs while the device is also encoding and uploading video for the
 * liveness check, and AWS refuses any camera it measures below 15fps
 * (`CAMERA_FRAMERATE_ERROR`). A prettier preview that causes the check to fail
 * is a bad trade, and on a mid-range Android it is a real possibility rather
 * than a theoretical one.
 *
 * So the loop governs itself:
 *
 *   - it processes at a FRACTION of the display resolution and lets the browser
 *     scale up. Skin smoothing and a shadow lift survive that; they are
 *     low-frequency edits by nature.
 *   - it measures its own frame cost and DROPS QUALITY when it overruns —
 *     first the processing resolution, then the frame rate, then it gives up
 *     entirely and shows the plain camera.
 *   - it never runs more often than the camera produces frames.
 *
 * Giving up is a normal outcome, not an error. `CAPTURE_LIVE.enabled` turns the
 * whole thing off, and the capture still gets the full-quality treatment either
 * way.
 */

import { useEffect, useRef, useState } from 'react';

import { CAPTURE_LIVE } from '@/features/kyc/config/capture';
import { applyLook, type LightingStyle } from '@/features/kyc/services/look';
import {
    compositePortrait,
    segmentToMask,
    type PortraitMask,
} from '@/features/kyc/services/portrait';
import { measureSkin } from '@/features/kyc/services/skinMask';

export interface LivePreviewState {
    /** True once the canvas is painting something. */
    active: boolean;
    /** Measured cost of one processed frame, in ms. */
    frameMs: number;
    /** Current processing scale, 0..1 of the display size. */
    scale: number;
    /** The loop gave up — the plain camera is showing. */
    surrendered: boolean;
}

export function useLivePreview({
    videoRef,
    canvasRef,
    enabled = true,
    beauty,
    lighting,
    portrait,
}: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    enabled?: boolean;
    beauty?: number;
    lighting?: LightingStyle;
    /** Defocus the background too. Costs a segmentation pass — see the loop. */
    portrait?: boolean;
}): LivePreviewState {
    const [state, setState] = useState<LivePreviewState>({
        active: false,
        frameMs: 0,
        scale: CAPTURE_LIVE.startScale,
        surrendered: false,
    });

    /*
     * The live settings, held in a ref rather than in the effect's deps.
     *
     * Changing the beauty strength must not tear down and rebuild the render
     * loop — that drops frames and, on the AWS path, restarts a canvas in the
     * middle of a check. The loop reads the current value each frame instead.
     */
    const settings = useRef({ beauty, lighting, portrait });
    // Written in an effect, not during render: a ref mutated while rendering is
    // a side effect in the render phase, which React's own lint rule refuses
    // and the compiler is entitled to reorder. An effect is early enough —
    // effects flush before the next animation frame.
    useEffect(() => {
        settings.current = { beauty, lighting, portrait };
    }, [beauty, lighting, portrait]);

    useEffect(() => {
        // No setState here: being switched off is DERIVED at the return
        // statement instead. Writing state from an effect body to say "I am not
        // running" is a cascading render to communicate something the caller
        // already knows.
        if (!enabled || !CAPTURE_LIVE.enabled) return;

        let raf = 0;
        let stopped = false;

        /** The canvas the look actually runs on — smaller than the display. */
        const work = document.createElement('canvas');

        // Widened from the `as const` literal so the governor can lower it.
        let scale: number = CAPTURE_LIVE.startScale;
        let overruns = 0;
        let surrendered = false;
        let lastPaint = 0;
        let minInterval = 1000 / CAPTURE_LIVE.maxFps;
        let smoothedMs = 0;

        /*
         * The face measurement is reused between frames.
         *
         * It is the one part of the pass that scans the whole buffer a second
         * time, and a face does not move appreciably in a tenth of a second.
         * Re-measuring every frame bought nothing and cost roughly a third of
         * the budget.
         */
        let face: ReturnType<typeof measureSkin> | null = null;
        let faceAt = 0;

        /**
         * The segmentation mask, and the request in flight for the next one.
         *
         * Held across frames deliberately — see the note at the portrait block
         * in the loop. `maskPending` stops a slow device queueing a second
         * segmentation before the first has answered, which is how a loop like
         * this collapses into a backlog it can never clear.
         */
        let mask: PortraitMask | null = null;
        let maskAt = 0;
        let maskPending = false;

        const publish = (next: Partial<LivePreviewState>) =>
            setState((s) => {
                const merged = { ...s, ...next };
                return s.active === merged.active &&
                    s.surrendered === merged.surrendered &&
                    Math.abs(s.frameMs - merged.frameMs) < 1.5 &&
                    s.scale === merged.scale
                    ? s
                    : merged;
            });

        const tick = (now: number) => {
            if (stopped) return;
            raf = requestAnimationFrame(tick);

            const video = videoRef.current;
            const out = canvasRef.current;
            if (!video || !out || video.readyState < 2 || !video.videoWidth) return;
            if (surrendered) return;
            if (now - lastPaint < minInterval) return;
            lastPaint = now;

            const started = performance.now();

            // The display canvas is sized to the video, once. The element's CSS
            // size is what decides how big it looks; this is its resolution.
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const dispW = Math.min(vw, CAPTURE_LIVE.maxDisplayWidth);
            const dispH = Math.round((dispW * vh) / vw);
            if (out.width !== dispW || out.height !== dispH) {
                out.width = dispW;
                out.height = dispH;
            }

            const pw = Math.max(64, Math.round(dispW * scale));
            const ph = Math.max(64, Math.round(dispH * scale));
            if (work.width !== pw || work.height !== ph) {
                work.width = pw;
                work.height = ph;
                // The geometry changed under it, so the cached measurement no
                // longer describes this buffer.
                face = null;
            }

            const wctx = work.getContext('2d', { willReadFrequently: true });
            const octx = out.getContext('2d');
            if (!wctx || !octx) return;

            try {
                wctx.drawImage(video, 0, 0, pw, ph);
            } catch {
                return;
            }

            // Refresh the face measurement on its own slower clock.
            if (!face || now - faceAt > CAPTURE_LIVE.faceRefreshMs) {
                try {
                    face = measureSkin(wctx.getImageData(0, 0, pw, ph).data, pw, ph);
                    faceAt = now;
                } catch {
                    face = null;
                }
            }

            applyLook(work, {
                beauty: settings.current.beauty,
                lighting: settings.current.lighting,
                force: true,
                face: face ?? undefined,
            });

            /*
             * ── Portrait, on its own much slower clock ──────────────────────
             *
             * Segmentation is by far the most expensive thing available here —
             * a whole neural network per call, against a per-pixel pass that
             * costs a few milliseconds. Running it every frame would eat the
             * entire budget, and for nothing: a head does not move appreciably
             * between frames, so the mask from 150ms ago still describes this
             * one. Compositing it, by contrast, is two draws and a GPU blur,
             * and that DOES happen every frame — which is what keeps the sharp
             * subject aligned with the picture even while the mask is stale.
             *
             * The request is fired and forgotten. Awaiting it inside the render
             * loop would serialise the preview behind the model, turning a
             * 6ms frame into a 25ms one; instead the answer lands whenever it
             * lands and the next frame picks it up.
             */
            if (settings.current.portrait) {
                if (!maskPending && now - maskAt > CAPTURE_LIVE.maskRefreshMs) {
                    maskPending = true;
                    maskAt = now;
                    // A copy, because `work` is overwritten by the next frame
                    // long before the segmenter answers.
                    const snapshot = document.createElement('canvas');
                    snapshot.width = pw;
                    snapshot.height = ph;
                    snapshot.getContext('2d')?.drawImage(work, 0, 0);
                    void segmentToMask(snapshot, {
                        mode: 'VIDEO',
                        // Monotonic, which MediaPipe requires in VIDEO mode —
                        // it rejects any frame whose timestamp did not advance.
                        timestamp: Math.round(now),
                    })
                        .then((m) => {
                            if (!stopped) mask = m;
                        })
                        .finally(() => {
                            maskPending = false;
                        });
                }
                if (mask) compositePortrait(work, mask);
            }

            octx.imageSmoothingEnabled = true;
            octx.imageSmoothingQuality = 'high';
            octx.drawImage(work, 0, 0, dispW, dispH);

            const cost = performance.now() - started;
            smoothedMs = smoothedMs ? smoothedMs * 0.85 + cost * 0.15 : cost;

            /*
             * ── The governor ────────────────────────────────────────────────
             *
             * Overrunning the budget once is noise — a garbage collection, a
             * layout, the segmenter warming up elsewhere. Overrunning it
             * repeatedly means this device cannot afford the effect at this
             * size, and the honest response is to take less rather than to keep
             * dropping frames out of something that is also trying to pass a
             * liveness check.
             *
             * Three steps down, then out. Never back up: oscillating between
             * two resolutions is more visible than sitting at the lower one,
             * and the thing being protected is a check that lasts seconds.
             */
            if (smoothedMs > CAPTURE_LIVE.frameBudgetMs) {
                overruns++;
                if (overruns > CAPTURE_LIVE.overrunsBeforeDrop) {
                    overruns = 0;
                    if (scale > CAPTURE_LIVE.minScale) {
                        scale = Math.max(CAPTURE_LIVE.minScale, scale - 0.15);
                        publish({ scale });
                    } else if (minInterval < 1000 / CAPTURE_LIVE.minFps) {
                        minInterval = 1000 / CAPTURE_LIVE.minFps;
                    } else {
                        surrendered = true;
                        octx.clearRect(0, 0, out.width, out.height);
                        publish({ surrendered: true, active: false });
                        return;
                    }
                }
            } else if (overruns > 0) {
                overruns--;
            }

            publish({ active: true, frameMs: smoothedMs, scale });
        };

        raf = requestAnimationFrame(tick);
        return () => {
            stopped = true;
            cancelAnimationFrame(raf);
        };
        // `beauty` / `lighting` are deliberately absent — they are read through
        // `settings` so a slider does not rebuild the loop mid-check.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, videoRef, canvasRef]);

    /*
     * `active` is ANDed with `enabled` rather than tracked.
     *
     * The loop cannot report its own shutdown — it is torn down by the effect
     * cleanup, which is too late to render with — so a stale `active: true`
     * would leave the caller hiding its video behind a canvas that has stopped
     * painting. Deriving it means switching the preview off is instantaneous
     * and needs no extra render.
     */
    return state.active && (!enabled || !CAPTURE_LIVE.enabled)
        ? { ...state, active: false }
        : state;
}

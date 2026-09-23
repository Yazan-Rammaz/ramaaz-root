'use client';

import { useEffect, useState } from 'react';
import { CAPTURE_OUTPUT } from '@/features/kyc/config/capture';
import { frameHasContent } from '@/features/kyc/services/faceCapture';
import { applyLook } from '@/features/kyc/services/look';
import { applyPortrait } from '@/features/kyc/services/portrait';
import type { LivenessResult } from '@/features/kyc/types/verification';

/**
 * The face to SHOW — looking the same however it got here.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Three sources can supply the picture, and they are not the same picture:
 *
 *   displayImageData   the capture with the look already on it — skin
 *                      smoothing and portrait lighting, applied at
 *                      `processFrame`. This is what the person saw the moment
 *                      the shutter went.
 *   faceImageData      the photograph of record. Tone-corrected, never
 *                      retouched (`CAPTURE_OUTPUT.bakeBeauty` is false and
 *                      stays false — see `look.ts`).
 *   storedFaceSrc      the same photograph of record, fetched back from the
 *                      backend after a reload.
 *
 * Every display site wrote `displayImageData ?? faceImageData ?? storedFaceSrc`
 * and got a flattering picture in the first case and a plain one in the other
 * two. So the face on the intro screen and on the comparison screen changed
 * the moment somebody refreshed, or on any later sign-in — same person, same
 * frame, visibly harsher — which reads as the camera having done something
 * wrong rather than as two code paths disagreeing.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 * Runs the same `applyLook` and `applyPortrait` the CAPTURE runs, in the same
 * order, over the un-retouched sources — so all three end up looking alike.
 *
 * Note which side of the split this is on: the live camera is deliberately
 * plain (`CAPTURE_LIVE.enabled` is false, and the blur is hard-off at those
 * call sites), while the photograph and every screen that shows it get the full
 * treatment. This hook is on the photograph's side.
 *
 * The raw frame is returned while the pass runs, so the picture is there
 * immediately and settles, rather than a grey box filling in late. That matters
 * more than it looks here: the portrait pass needs a segmenter model, and after
 * a reload — the case this hook exists for — that model is cold.
 *
 * ⚠️ DISPLAY ONLY, and the distinction is load-bearing. The value returned here
 * must never be posted as `selfie`, enrolled, or handed to CompareFaces. The
 * comparison reads exactly the mid-frequency band the smoothing attenuates, and
 * an identity record must hold the frame the sensor recorded. Those call sites
 * take `faceImageData` / `fetchStoredFace()` directly and must keep doing so —
 * this hook is deliberately not in their path.
 */
export function useFacePhoto(
    liveness: LivenessResult | null,
    storedFaceSrc: string | null,
): string | null {
    /** The in-memory capture already carries the look; nothing to redo. */
    const looked = liveness?.displayImageData ?? null;
    /** A truthful frame, and therefore a plain one. */
    const raw = liveness?.faceImageData ?? storedFaceSrc ?? null;

    /**
     * The retouched frame, TAGGED with the source it came from.
     *
     * The tag is what keeps a stale picture off the screen without clearing
     * state on the way in: when `raw` changes, `processed.src` no longer
     * matches and the result is ignored until the new pass finishes. Resetting
     * to null synchronously in the effect would do the same job and cost a
     * cascading render every time this hook runs — which, on a screen holding a
     * live camera, is often.
     */
    const [processed, setProcessed] = useState<{ src: string; out: string } | null>(null);

    useEffect(() => {
        // Nothing to do: either the look is already on it, or there is no face.
        if (looked || !raw) return;
        // Already done for exactly this frame.
        if (processed?.src === raw) return;

        let cancelled = false;

        void (async () => {
            try {
                const image = new Image();
                // Same origin in both cases — a `data:` URL, or `/api/face-capture`
                // on our own host — so the canvas is never tainted and
                // `toDataURL` cannot throw a security error.
                image.src = raw;
                await image.decode();
                if (cancelled) return;

                const canvas = document.createElement('canvas');
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(image, 0, 0);

                applyLook(canvas);

                /*
                 * The look BEFORE the blur, and the order is not arbitrary —
                 * `processFrame` carries the full argument. In short: the
                 * beauty half finds skin by tone and decides what to smooth by
                 * local contrast, so running it over an already-defocused room
                 * makes every beige surface back there read as flawless skin
                 * and get "corrected" again. Sharp room first, then defocus it.
                 *
                 * This is the DISPLAY path, so it matches `processFrame`
                 * deliberately: the photograph is blurred, and every screen
                 * that shows it afterwards has to be too, or the face changes
                 * the moment somebody refreshes. It self-gates on
                 * `CAPTURE_PORTRAIT.enabled` and fails soft to an untouched
                 * canvas.
                 */
                await applyPortrait(canvas);
                if (cancelled) return;

                // The same floor `processFrame` keeps: canvas work fails by
                // painting a silently wrong picture rather than by throwing, so
                // the result is checked rather than trusted. A blank means a bug
                // in a stage, and the plain frame is a far better outcome than a
                // black rectangle where somebody's face should be.
                if (!frameHasContent(canvas)) {
                    console.warn('[face] the look blanked a stored frame — showing it unretouched');
                    return;
                }

                if (!cancelled) {
                    setProcessed({
                        src: raw,
                        out: canvas.toDataURL('image/jpeg', CAPTURE_OUTPUT.jpegQuality),
                    });
                }
            } catch {
                // Decode failure, no 2d context, a stored face that 404s. All of
                // them end the same way: show what we were given.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [looked, raw, processed]);

    // `raw` while the pass runs, so the face appears immediately and sharpens
    // into the retouched version — rather than a grey box that fills in late.
    //
    // The tag check is the staleness guard: a result belonging to a previous
    // frame is simply not used.
    return looked ?? (processed?.src === raw ? processed.out : null) ?? raw;
}

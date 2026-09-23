'use client';

import { useEffect, useState } from 'react';
import { CAPTURE_OUTPUT } from '@/features/kyc/config/capture';
import { frameHasContent } from '@/features/kyc/services/faceCapture';
import { applyLook } from '@/features/kyc/services/look';
import { applyPortrait } from '@/features/kyc/services/portrait';
import { fetchStoredFace } from '@/features/kyc/services/storedFace';
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

    /**
     * A truthful frame, and therefore a plain one — but after a reload it is a
     * URL rather than bytes, and the difference matters everywhere below.
     */
    const source = liveness?.faceImageData ?? storedFaceSrc ?? null;
    const remote = !!source && !source.startsWith('data:');

    /**
     * The stored face, PULLED DOWN AS BYTES before anything else happens.
     *
     * ── Why the route is never handed to an <img> ───────────────────────────
     * It used to be, and three things went wrong with it at once:
     *
     *   1. It is the FALLBACK, and the fallback became the final answer. The
     *      look pass below decodes that URL, retouches it and swaps in a data:
     *      URL — and if any stage of it failed, the swap never happened and the
     *      screen kept the route forever. Silently: the catch had nothing to
     *      say and a face that never got retouched looks like a face, just a
     *      harsher one. That is the exact drift this hook exists to prevent,
     *      arriving through the hook itself.
     *   2. `/api/face-capture` is `Cache-Control: no-store` — correctly; it is
     *      somebody's face tied to one sign-in. So every element pointed at it
     *      is a separate round trip THROUGH OUR WORKER TO THE BACKEND. With a
     *      pane of glass over the picture that is two, because the pane draws
     *      its own copy of the same src (see PhotoGlass), and the two can land
     *      at different moments — a pane standing over a picture that is not
     *      there yet.
     *   3. A 404 — no challenge cookie, upstream gone — rendered as a BROKEN
     *      image rather than as no photo. The screens have a grey placeholder
     *      for exactly that case and could not reach it.
     *
     * One fetch, one data: URL, shared by the picture, the pane and the look
     * pass. `fetchStoredFace` is the sanctioned module for it (AGENTS.md §2 —
     * components never call `fetch`, and neither does this).
     *
     * ⚠️ This does NOT put a backend URL in the page, and cannot be changed to.
     * The browser never addresses a backend (§2), and `img-src 'self' data:
     * blob:` in the CSP would refuse the request before it was made. The bytes
     * come through our own origin or they do not come at all.
     */
    const [fetched, setFetched] = useState<{ src: string; out: string } | null>(null);

    useEffect(() => {
        if (!remote || !source) return;
        if (fetched?.src === source) return;

        let cancelled = false;
        void (async () => {
            try {
                const data = await fetchStoredFace();
                if (!cancelled) setFetched({ src: source, out: data });
            } catch (err) {
                // Loud, and specific. The screens fall back to their own grey
                // placeholder, which is the honest picture of "there is no
                // photo" — but WHY there is none is not inferable from a grey
                // box, and this is the only place that knows.
                console.warn('[face] the stored face could not be fetched', err);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [remote, source, fetched]);

    /**
     * The bytes, or nothing. Never the route.
     *
     * The tag check is the staleness guard, the same one `processed` uses: a
     * fetch belonging to a previous source is not used for this one.
     */
    const raw = remote ? (fetched?.src === source ? fetched.out : null) : source;

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
                // Always a `data:` URL by this point — the stored face was
                // pulled down as bytes above — so the canvas is never tainted,
                // `toDataURL` cannot throw a security error, and the decode
                // cannot fail on a 404 the way it could when this was handed a
                // route.
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
            } catch (err) {
                /*
                 * ⚠️ SAY SO. This was a bare `catch {}` with a comment, and the
                 * silence is what let a real failure sit on screen unnoticed:
                 * every stage here ends the same way — show the frame
                 * unretouched — and an unretouched face still looks like a
                 * face. Nobody can tell from the picture that the look never
                 * ran; the only symptom is that this person looks harsher after
                 * a refresh than they did before it, which reads as the camera's
                 * fault.
                 *
                 * The fallback is still the right behaviour. It just should not
                 * be a secret.
                 */
                console.warn('[face] the look could not be applied — showing the plain frame', err);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [looked, raw, processed]);

    /*
     * `raw` while the look pass runs, so the face appears as soon as the bytes
     * are here and sharpens into the retouched version — rather than a grey box
     * that fills in late.
     *
     * ⚠️ EVERY BRANCH IS A `data:` URL OR NULL. Null is a real answer and the
     * screens draw their placeholder for it: after a reload there is a moment
     * before the stored face has been fetched, and a 404 never resolves at all.
     * The route that used to stand in for this window is gone from the return
     * on purpose — it was a fallback that could become permanent, and did.
     *
     * The tag checks are the staleness guard: a result belonging to a previous
     * frame is simply not used.
     */
    return looked ?? (processed?.src === raw ? processed.out : null) ?? raw;
}

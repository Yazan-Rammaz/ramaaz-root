/**
 * The look — skin smoothing and portrait lighting, in ONE pass over the pixels.
 *
 * ── Why these are one function and not two ──────────────────────────────────
 * They were two (`beauty.ts`, `lighting.ts`) and it was the wrong shape as soon
 * as the live preview arrived. Each did its own `getImageData` / per-pixel loop
 * / `putImageData`, so running both cost four full traversals of a 400x450
 * buffer plus two large allocations — per frame, thirty times a second, on a
 * phone that is simultaneously streaming video to Rekognition. Merged, it is
 * one read, one loop, one write.
 *
 * Keeping them separate for "clarity" would also have meant the preview and the
 * capture running different code, which is the exact failure this whole
 * directory is organised against: `processFrame` calls this, the live loop
 * calls this, and the bench calls this with individual stages switched off. One
 * implementation, so a look approved on the bench is the look that ships and
 * the look you see while the camera is open.
 *
 * ── Both edits are DISPLAY-ONLY, permanently ────────────────────────────────
 * `CAPTURE_OUTPUT.bakeBeauty` is false and there is no reason to revisit it.
 * The photograph posted to the backend, written to the identity record and
 * handed to CompareFaces is the frame the sensor recorded. Retouching changes
 * evidence in a KYC flow — the comparison reads exactly the mid-frequency band
 * the smoothing attenuates — and separating the two images costs nothing: the
 * person sees a flattering picture and the system receives the truthful one.
 *
 * ── What each half does, briefly ────────────────────────────────────────────
 *
 * BEAUTY is frequency separation with edge preservation, not a blur. Blurring
 * skin blurs eyelashes, nostrils and the lip line, which is the wax-model look
 * that reads instantly as a filter — and is what got the first attempt reverted
 * ("the face looked blurred", `git log` 5d7f21c). Instead the frame is split
 * into a blurred base and the detail removed; only LOW-CONTRAST detail (pores,
 * blotches, noise) is attenuated, while HIGH-CONTRAST detail (lashes, nostrils,
 * the jawline) is kept and slightly sharpened.
 *
 * LIGHTING is Apple's Studio Light: a large soft frontal source. The part that
 * matters is not that the face is brighter but that the SHADOWED SIDE is lifted
 * far more than the lit side, so harsh modelling softens out. A uniform lift is
 * the brightness slider and looks like it.
 *
 * ⚠️ Neither uses the segmentation mask, and that is deliberate. Relighting or
 * smoothing inside a mask turns every segmentation error into a visible seam
 * around the hair — "a studio sweep put a seam where the mask was least
 * certain" is why the first version died. Both are weighted by skin membership
 * and (for the light) a broad radial falloff: continuous functions with no
 * boundary anywhere, so there is no edge to be wrong about. The cost is that
 * hair and clothing are not relit, only the face. That is the right trade: the
 * face is what anyone looks at, and no amount of correct brightening elsewhere
 * makes up for an outline around somebody's head.
 */

import { CAPTURE_BEAUTY, CAPTURE_LIGHTING } from '@/features/kyc/config/capture';
import { blurredCopy } from './canvasBlur';
import { measureSkin, skinWeight } from './skinMask';

export type LightingStyle = 'natural' | 'studio' | 'contour';

export interface LookOptions {
    /**
     * Beauty strength 0..1, or false to skip the stage. Omitted means the
     * configured default.
     */
    beauty?: number | false;
    /** Lighting style, or false to skip. Omitted means the configured default. */
    lighting?: LightingStyle | false;
    /** Lighting strength 0..1. Omitted means the configured default. */
    lightingStrength?: number;
    /** Run even when the stage is disabled in config — for the bench. */
    force?: boolean;
    /**
     * A face measurement to reuse instead of taking one.
     *
     * The live loop measures at a low rate and reuses the answer, because a
     * face does not move far in 100ms and the measurement is the one part of
     * this that scans the whole buffer a second time.
     */
    face?: ReturnType<typeof measureSkin>;
}

export interface LookResult {
    applied: boolean;
    reason?: 'disabled' | 'read-failed' | 'no-skin';
    beautyApplied: boolean;
    lightingApplied: boolean;
    style?: LightingStyle;
    /** Smoothing radius used, in pixels. */
    radius?: number;
    skinShare?: number;
    faceWidth?: number;
}

/**
 * How much of a detail difference counts as texture rather than a feature.
 *
 * `exp(-(d/T)^2)`: 1 for no difference at all, falling to near zero well before
 * the difference is large enough to be a facial feature. Precomputed over the
 * full signed range a channel difference can take, because this is evaluated
 * three times per pixel and `exp` is not free.
 *
 * Cached on the threshold, since the bench is the only thing that ever changes
 * it and rebuilding 511 entries per frame is pure waste.
 */
let detailLut: Float32Array | null = null;
let detailLutFor = -1;
function getDetailLut(threshold: number): Float32Array {
    if (detailLut && detailLutFor === threshold) return detailLut;
    const lut = new Float32Array(511);
    for (let i = 0; i < 511; i++) {
        const d = (i - 255) / threshold;
        lut[i] = Math.exp(-d * d);
    }
    detailLut = lut;
    detailLutFor = threshold;
    return lut;
}

/** Apply the look to a canvas, in place. Never throws; fails soft to a no-op. */
export function applyLook(canvas: HTMLCanvasElement, opts: LookOptions = {}): LookResult {
    const off: LookResult = { applied: false, beautyApplied: false, lightingApplied: false };

    const wantBeauty =
        opts.beauty === false
            ? false
            : (opts.beauty ?? (CAPTURE_BEAUTY.enabled || opts.force ? CAPTURE_BEAUTY.strength : 0));

    const styleRaw = opts.lighting === undefined ? CAPTURE_LIGHTING.style : opts.lighting;
    const wantLight: LightingStyle | false =
        styleRaw === false || styleRaw === 'natural'
            ? false
            : !CAPTURE_LIGHTING.enabled && !opts.force
              ? false
              : styleRaw;

    const beautyAmount = wantBeauty === false ? 0 : Math.max(0, Math.min(1, wantBeauty));
    if (beautyAmount <= 0 && !wantLight) return { ...off, reason: 'disabled' };

    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return { ...off, reason: 'read-failed' };

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ...off, reason: 'read-failed' };

    let img: ImageData;
    try {
        img = ctx.getImageData(0, 0, w, h);
    } catch {
        return { ...off, reason: 'read-failed' };
    }
    const d = img.data;

    // ── Where the face is ───────────────────────────────────────────────────
    /*
     * Every radius below is measured against the FACE, not the image.
     *
     * ⚠️ This is the mistake that sank the first attempt, quoted from the
     * revert: "the smoothing radius was a fraction of image width and the
     * face's share of the frame had changed underneath it". The same number was
     * a whisper on a wide shot and a smear on a tight one, and no constant
     * fixes that, because the constant is not the problem.
     */
    const face = opts.face ?? measureSkin(d, w, h);
    const minShare = Math.min(CAPTURE_BEAUTY.minSkinShare, CAPTURE_LIGHTING.minSkinShare);
    if (!face.box || face.share < minShare) {
        // Nobody in the picture. Doing nothing is the correct outcome, not a
        // failure — editing whatever happened to land in the skin-tone cluster
        // would be worse than leaving it alone.
        return { ...off, reason: 'no-skin', skinShare: face.share };
    }

    // ── The low-frequency band, for the beauty half ─────────────────────────
    let base: Uint8ClampedArray | null = null;
    let radius = 0;
    if (beautyAmount > 0) {
        radius = Math.round(
            Math.min(
                CAPTURE_BEAUTY.radiusMax,
                Math.max(
                    CAPTURE_BEAUTY.radiusMin,
                    face.faceWidth * w * CAPTURE_BEAUTY.radiusPerFaceWidth,
                ),
            ),
        );
        const blurred = blurredCopy(canvas, radius);
        if (blurred) {
            try {
                base = blurred
                    .getContext('2d', { willReadFrequently: true })!
                    .getImageData(0, 0, w, h).data;
            } catch {
                base = null;
            }
        }
    }

    const lut = getDetailLut(CAPTURE_BEAUTY.detailThreshold);
    const clarity = CAPTURE_BEAUTY.clarity;
    const glow = CAPTURE_BEAUTY.glow;

    // ── The softbox, for the lighting half ──────────────────────────────────
    /*
     * A broad radial falloff centred on the face and reaching past it. This is
     * what stops the light being uniform: a real source nearer the subject than
     * the wall falls off across the frame, and without that the lift reads as
     * an exposure change rather than as a light.
     *
     * Distances are in frame-WIDTH units so the falloff stays circular on a 4:3
     * capture instead of going elliptical.
     */
    const amount = Math.max(0, Math.min(1, opts.lightingStrength ?? CAPTURE_LIGHTING.strength));
    const keyR = Math.max(0.2, face.faceWidth * CAPTURE_LIGHTING.keyRadiusPerFaceWidth);
    const aspect = h / w;
    const lift = CAPTURE_LIGHTING.shadowLift * amount;
    const flatten = CAPTURE_LIGHTING.flatten * amount;
    const gain = CAPTURE_LIGHTING.skinGain * amount;
    const target = CAPTURE_LIGHTING.flattenTarget;
    const contour = CAPTURE_LIGHTING.contourDepth * amount;
    const studio = wantLight === 'studio';

    for (let y = 0; y < h; y++) {
        const ny = (y / h - face.cy) * aspect;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];

            // Includes the dark-pixel guard: chroma is noise as brightness
            // approaches zero, so without it every edit here does its strongest
            // work in the noisiest part of the picture. See `skinMask.ts`.
            const skin = skinWeight(r, g, b);
            if (skin <= 0.01) continue;

            let key = 0;
            if (wantLight) {
                const nx = x / w - face.cx;
                const dist = Math.sqrt(nx * nx + ny * ny) / keyR;
                // Smooth, bounded and zero outside the radius — no
                // discontinuity anywhere, which is the entire point.
                if (dist < 1) key = (1 - dist * dist) ** 2;
            }
            const lightW = skin * key;

            for (let c = 0; c < 3; c++) {
                let v = d[i + c];

                // ── Beauty ──────────────────────────────────────────────────
                if (base && beautyAmount > 0) {
                    const diff = v - base[i + c];
                    // 1 for texture, 0 for a real feature. The whole trick.
                    const texture = lut[(diff | 0) + 255];
                    v -= diff * beautyAmount * skin * texture;
                    /*
                     * Put a little of the FEATURE detail back, and only that.
                     *
                     * `1 - texture` is nonzero exactly where the smoothing did
                     * nothing — lashes, nostrils, the lip line — so this
                     * sharpens the face without touching the skin just
                     * softened. It is what stops the result reading as
                     * soft-focus: the eye judges sharpness from edges, and
                     * those edges end up crisper than they started.
                     */
                    if (clarity > 0) v += diff * clarity * (1 - texture) * skin;
                    if (glow > 0) {
                        const n = v / 255;
                        v += glow * 255 * skin * 4 * n * (1 - n);
                    }
                }

                // ── Lighting ────────────────────────────────────────────────
                if (lightW > 0.01) {
                    const n = Math.max(0, Math.min(1, v / 255));
                    if (studio) {
                        /*
                         * Fill the shadows; barely touch the highlights.
                         *
                         * `(1 - n)^1.6` is 1 at black and 0 at white, so the
                         * lift is strongest exactly on the shadowed side of the
                         * face and vanishes on the lit side. THIS is what makes
                         * it read as a soft source rather than as the
                         * brightness slider — and because it reaches zero at
                         * white it cannot blow a highlight however high it goes.
                         */
                        v += lift * lightW * (1 - n) ** 1.6 * 255;
                        /*
                         * Toward an even tone — UPWARD ONLY.
                         *
                         * `target - n` is negative above the target, and the
                         * symmetric version dragged highlights DOWN: checked
                         * numerically, pure white came out at 243 and the
                         * catchlight in the eye lost its snap. A face whose
                         * highlights have been pulled toward grey reads as
                         * hazy, which is the opposite of a studio light. Fill
                         * light adds; it never subtracts.
                         */
                        if (target > n) v += flatten * lightW * (target - n) * 255;
                        v += gain * lightW * n * (1 - n) * 2 * 255;
                    } else {
                        /*
                         * Contour — the opposite intent. A harder, more
                         * directional source: shadows deepen and highlights
                         * strengthen, so bone structure is more pronounced.
                         */
                        v -= contour * lightW * (1 - n) ** 1.6 * 255;
                        v += contour * lightW * n ** 1.6 * 255;
                    }
                }

                d[i + c] = v;
            }
        }
    }

    ctx.putImageData(img, 0, 0);
    return {
        applied: true,
        beautyApplied: beautyAmount > 0 && !!base,
        lightingApplied: !!wantLight,
        style: wantLight || 'natural',
        radius,
        skinShare: face.share,
        faceWidth: face.faceWidth,
    };
}

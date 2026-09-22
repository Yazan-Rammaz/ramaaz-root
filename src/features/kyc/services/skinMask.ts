/**
 * Where the skin is, and how big the face is — shared by every stage that
 * needs to treat a person differently from the room behind them.
 *
 * `beauty.ts` uses it to smooth skin and nothing else; `lighting.ts` uses it to
 * relight the face and nothing else. Both need the same answer, and two copies
 * of a chroma threshold would drift into two different ideas of where somebody's
 * cheek ends.
 *
 * ── Why chroma and not brightness ───────────────────────────────────────────
 * Skin varies enormously in BRIGHTNESS across people and lighting, and very
 * little in CHROMA: the Cb/Cr cluster for skin is tight and largely independent
 * of complexion, which is the property this depends on. A rule written in RGB
 * is really a rule about how brightly lit someone is, and it fails on the darker
 * and the more brightly lit halves of any real population — which, for a KYC
 * flow used across three countries, is not an acceptable way to fail.
 *
 * ── Why the falloff is smooth ───────────────────────────────────────────────
 * The usual implementation is a box: Cb in 77..127, Cr in 133..173, in or out.
 * A box puts a hard edge wherever a cheek crosses the boundary, and because the
 * boundary moves with the lighting, that edge SHIMMERS between frames. Every
 * consumer of this mask blends with it, so a smooth membership is the
 * difference between an effect and a visible artefact.
 */

/**
 * Skin membership 0..1, indexed by (Cb >> 2, Cr >> 2).
 *
 * Quarter resolution — 64 x 64 — because the function is smooth and the
 * difference between adjacent chroma values is far below anything visible.
 * 4096 entries built once per page instead of two million `exp()` calls per
 * capture.
 */
const SKIN_LUT = (() => {
    const lut = new Float32Array(64 * 64);
    for (let cbq = 0; cbq < 64; cbq++) {
        for (let crq = 0; crq < 64; crq++) {
            const dcb = (cbq * 4 + 2 - 102) / 26;
            const dcr = (crq * 4 + 2 - 153) / 20;
            lut[cbq * 64 + crq] = Math.exp(-(dcb * dcb + dcr * dcr));
        }
    }
    return lut;
})();

/**
 * How much this pixel is skin, 0..1.
 *
 * ⚠️ The luminance guard is not optional. Chroma is meaningless as brightness
 * approaches zero — the Cb/Cr of a near-black pixel is noise, and a shadowed
 * fold of a jacket lands in the skin cluster as often as not. Without it, every
 * stage downstream does its strongest work in the darkest part of the picture,
 * which is exactly where noise lives and where any edit is most visible as
 * mush.
 */
export function skinWeight(r: number, g: number, b: number): number {
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    let skin = SKIN_LUT[((cb >> 2) & 63) * 64 + ((cr >> 2) & 63)];

    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y < 40) skin *= Math.max(0, y - 16) / 24;
    return skin;
}

export interface SkinMeasurement {
    /** Share of sampled pixels that read as skin, 0..1. */
    share: number;
    /** Face bounding box, in 0..1 of the frame. Null when no skin was found. */
    box: { x0: number; y0: number; x1: number; y1: number } | null;
    /** Face width as a fraction of the frame width — the scale every radius uses. */
    faceWidth: number;
    /** Centre of the face, in 0..1 of the frame. */
    cx: number;
    cy: number;
}

/**
 * Find the face by its skin, on a downsample.
 *
 * ── Why this exists rather than a face detector ─────────────────────────────
 * There is no face box on this path. AWS does not surface its own detection,
 * and loading a second detector to draw a rectangle we can infer for free would
 * add a model download to a screen that already waits on two.
 *
 * What it is FOR matters more than its precision: every radius in the stages
 * downstream is measured against the face rather than the image. That is the
 * documented reason the first attempt at all of this was reverted — "the
 * smoothing radius was a fraction of image width and the face's share of the
 * frame had changed underneath it" — so a rough, self-calibrating measurement
 * is worth far more here than an exact one would be.
 *
 * `step` samples rather than reading every pixel: a bounding box does not need
 * two million samples to be accurate to within a few pixels.
 */
export function measureSkin(data: Uint8ClampedArray, w: number, h: number): SkinMeasurement {
    const step = Math.max(1, Math.floor(Math.min(w, h) / 120));
    let count = 0;
    let sampled = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;

    for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            sampled++;
            // A firm threshold is right HERE, where the question is "where is
            // the face" rather than "how much to edit this pixel". The soft
            // membership above is what the blending uses.
            if (skinWeight(data[i], data[i + 1], data[i + 2]) > 0.5) {
                count++;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }

    const share = sampled ? count / sampled : 0;
    if (x1 < x0 || y1 < y0) {
        return { share, box: null, faceWidth: 0, cx: 0.5, cy: 0.5 };
    }

    const box = { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
    return {
        share,
        box,
        faceWidth: box.x1 - box.x0,
        cx: (box.x0 + box.x1) / 2,
        cy: (box.y0 + box.y1) / 2,
    };
}

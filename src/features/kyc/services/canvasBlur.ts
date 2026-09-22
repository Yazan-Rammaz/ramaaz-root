/**
 * A Gaussian blur that does not darken its own edges.
 *
 * ── Why this is not one line ────────────────────────────────────────────────
 * Canvas's `filter: blur()` samples outside the drawn image as TRANSPARENT
 * BLACK. Blur an image that exactly fills its canvas and the border fades to
 * nothing — a dark rim that is not a design choice but an artefact, and worst
 * exactly where the radius is largest.
 *
 * The obvious dodge is to draw the source oversized so the fade falls
 * off-canvas. That works and costs a magnified copy of everything, which on a
 * portrait means a blurred head slightly larger than and directly behind the
 * real one. It reads as somebody looming in the doorway, and it is one of the
 * four things that sank the first version of `portrait.ts` (`git log` 5d7f21c).
 *
 * So the edges are CLAMPED instead: the frame is copied into a larger canvas
 * whose margin is its own edge pixels stretched outward, giving the blur real
 * pixels to reach for. Nothing is scaled. This is what a GPU sampler does for
 * free and canvas does not.
 *
 * Shared by `portrait.ts` (defocusing the room) and `beauty.ts` (the low
 * frequency band of the skin smoothing), because the two had no business
 * carrying separate copies of a subtlety this easy to get wrong.
 */

/** Copy `src` into a canvas `pad` px larger on every side, edges extended. */
function padWithClampedEdges(src: HTMLCanvasElement, pad: number): HTMLCanvasElement | null {
    const w = src.width;
    const h = src.height;
    const out = document.createElement('canvas');
    out.width = w + pad * 2;
    out.height = h + pad * 2;
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    // Edges — a one-pixel strip of the source stretched across the margin.
    ctx.drawImage(src, 0, 0, w, 1, pad, 0, w, pad); // top
    ctx.drawImage(src, 0, h - 1, w, 1, pad, h + pad, w, pad); // bottom
    ctx.drawImage(src, 0, 0, 1, h, 0, pad, pad, h); // left
    ctx.drawImage(src, w - 1, 0, 1, h, w + pad, pad, pad, h); // right

    // Corners — a single pixel each, which is what clamp-to-edge means there.
    ctx.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
    ctx.drawImage(src, w - 1, 0, 1, 1, w + pad, 0, pad, pad);
    ctx.drawImage(src, 0, h - 1, 1, 1, 0, h + pad, pad, pad);
    ctx.drawImage(src, w - 1, h - 1, 1, 1, w + pad, h + pad, pad, pad);

    ctx.drawImage(src, pad, pad);
    return out;
}

/**
 * A blurred copy of `src`, same size, with no edge falloff.
 *
 * Returns null rather than throwing on any failure — callers treat that as
 * "skip this stage", which keeps the floor at the frame the camera gave.
 */
export function blurredCopy(src: HTMLCanvasElement, radius: number): HTMLCanvasElement | null {
    if (!src.width || !src.height || radius <= 0) return null;

    // Twice the radius of margin. A Gaussian is effectively zero past about 3
    // sigma and canvas's `blur(n)` uses n as sigma, so 2n leaves a little of
    // the tail out — which is invisible against the cost of padding a 1280x960
    // frame by three times a 48px radius on every side.
    const pad = Math.ceil(radius * 2);
    const padded = padWithClampedEdges(src, pad);
    if (!padded) return null;

    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(padded, -pad, -pad);
    ctx.filter = 'none';
    return out;
}

/**
 * Portrait mode: the person sharp, the room behind them soft.
 *
 * ⚠️ THIS FILE EXISTED BEFORE AND WAS DELETED. Read `git log` 7cecf4b (added)
 * and 5d7f21c (reverted) before changing anything structural here — the revert
 * message is the best description of how this goes wrong, and four specific
 * mistakes are designed out below. If a change reintroduces one of them it will
 * look fine on the face you tested it on and wrong on the next one, which is
 * exactly how the first version survived long enough to ship.
 *
 * ── The four, and what replaces them ────────────────────────────────────────
 *
 * 1. IT CUT THE SUBJECT OUT FIRST. That left a person-shaped hole in the
 *    background which had to be filled before it could be blurred, and every
 *    way of filling it invented pixels: the room shrunk inward drew a hard line
 *    around the head, the room smeared outward drew streaks off the hair.
 *    → Nothing is cut out. The whole frame is blurred IN PLACE and the sharp
 *      subject is composited back on top. There is no hole, so there is nothing
 *      to invent, and the "background" behind the head is the real background
 *      that was always there.
 *
 * 2. THE BLURRED COPY WAS DRAWN OVERSIZED, to keep the blur's own edge falloff
 *    out of frame — which magnified it, and a magnified blurred head behind the
 *    real head reads as someone looming in the doorway.
 *    → `blurredCopy` (services/canvasBlur.ts) instead, which clamps the edges:
 *      the frame is copied into a larger canvas whose margin is its own edge
 *      pixels extended outward, so the blur has real pixels to sample at the
 *      border and the centre is never scaled. That module carries the full
 *      explanation; `beauty.ts` needs the same subtlety and now shares it.
 *
 * 3. THE BLUR RADIUS WAS A FRACTION OF IMAGE WIDTH. The face's share of the
 *    frame changes between captures, so one setting was a whisper on a wide
 *    shot and a smear on a tight one.
 *    → The radius is a fraction of the SUBJECT's width (`CAPTURE_PORTRAIT
 *      .blurRadiusPerFaceWidth`). Proportionally identical at any framing,
 *      which is the only way the number means anything.
 *
 * 4. THE MASK EDGE WAS HARD, so everywhere segmentation was wrong — and it is
 *    always a little wrong, around hair especially — blur landed on skin.
 *    → The mask is feathered before compositing. A mask error now costs a soft
 *      millimetre at the silhouette instead of a blurred cheek, and a soft
 *      silhouette is what an out-of-focus falloff looks like anyway.
 *
 * ── What is NOT attempted ───────────────────────────────────────────────────
 * Replacing the background — flat white, a studio sweep — was tried and read as
 * a cut-out, with the seam landing exactly where segmentation is least certain.
 * The room stays. It is only defocused. A blur that is slightly wrong at the
 * edge still looks like a photograph; a matte that is slightly wrong at the
 * edge looks like a mistake.
 *
 * Skin work is a separate stage with a separate rule — see `beauty.ts`, which
 * is display-only for reasons this file does not need to repeat.
 */

import { CAPTURE_PORTRAIT } from '@/features/kyc/config/capture';
import { blurredCopy } from './canvasBlur';

/**
 * The Selfie Segmenter, self-hosted like every other model here.
 *
 * `script-src` and `connect-src` are `'self'`, so MediaPipe's own bucket is
 * blocked — and a sign-in that depends on a third-party CDN staying reachable
 * is a sign-in with one more way to fail. `scripts/sync-vendor.mjs` fetches it.
 */
const SEGMENTER_MODEL_PATH = '/vendor/mediapipe/selfie_segmenter.tflite';
const MEDIAPIPE_BASE_URL = '/vendor/mediapipe';

type Segmenter = import('@mediapipe/tasks-vision').ImageSegmenter;

type Mode = 'IMAGE' | 'VIDEO';

/**
 * One segmenter per running mode.
 *
 * MediaPipe binds the mode at creation, and `setOptions` to switch it rebuilds
 * the graph — which on the live path would mean tearing down and rebuilding the
 * model every time a capture happened mid-preview. Two instances share the same
 * downloaded weights and cost only a little GPU memory.
 */
const cached: Partial<Record<Mode, Segmenter>> = {};
const loading: Partial<Record<Mode, Promise<Segmenter | null>>> = {};

/**
 * Load the segmenter once per page.
 *
 * Returns null rather than throwing on every failure path — a missing model, a
 * machine with no working GPU delegate, a browser that cannot run the WASM. The
 * caller's answer to null is "return the original photograph", which is a
 * cosmetic disappointment. Throwing would make it a failed sign-in.
 */
export async function loadSegmenter(mode: Mode = 'IMAGE'): Promise<Segmenter | null> {
    const hit = cached[mode];
    if (hit) return hit;
    const pending = loading[mode];
    if (pending) return pending;

    loading[mode] = (async () => {
        try {
            const vision = await import('@mediapipe/tasks-vision');
            const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_BASE_URL);
            const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: SEGMENTER_MODEL_PATH, delegate: 'GPU' },
                runningMode: mode,
                // The category mask is a per-pixel label, which is all that is
                // needed — the soft edge this wants comes from feathering
                // below, not from a confidence ramp. Asking for confidence
                // masks as well would allocate a second full-size float buffer
                // per call for nothing.
                outputCategoryMask: true,
                outputConfidenceMasks: false,
            });
            cached[mode] = segmenter;
            return segmenter;
        } catch {
            return null;
        } finally {
            delete loading[mode];
        }
    })();

    return loading[mode]!;
}

/**
 * Start the download early, so the first frame does not wait for it.
 *
 * Both modes, because the live preview and the capture each need their own and
 * the weights are fetched once either way. On the live path especially this
 * matters: loading lazily would mean the preview runs flat for the first second
 * or two and then visibly changes, which reads as a glitch.
 */
export function kickstartSegmenter(): void {
    void loadSegmenter('IMAGE');
    void loadSegmenter('VIDEO');
}

/** What `applyPortrait` did, for the bench to print. */
export interface PortraitResult {
    applied: boolean;
    /** Why it declined, when it did. */
    reason?: 'no-model' | 'no-mask' | 'subject-too-small' | 'subject-too-large' | 'read-failed';
    /** Share of the frame the segmenter called "person", 0..1. */
    subjectShare?: number;
    /** Blur radius actually used, in pixels of the capture. */
    blurRadius?: number;
    /** Subject bounding-box width as a fraction of the frame. */
    subjectWidth?: number;
}

/**
 * Turn the segmenter's category mask into a feathered alpha mask at full size.
 *
 * Two things happen in one draw, and they are the same operation: the small
 * mask is scaled up to the capture's size, and `filter: blur()` both smooths
 * the upscale and applies the feather. Doing them separately would blur an
 * already-blocky upscale, which keeps the blocks.
 *
 * ⚠️ The mask is drawn LARGER than the canvas by the feather amount, on
 * purpose. Blur fades alpha toward the edges, and a subject whose shoulders
 * touch the bottom of the frame would otherwise go semi-transparent along that
 * edge — blurred shoulders under a sharp head. Pushing the fade outside the
 * canvas is the same clamp-to-edge argument `blurredCopy` makes, for the
 * same reason.
 */
function buildAlphaMask(
    mask: Uint8Array,
    maskW: number,
    maskH: number,
    personLabel: number,
    outW: number,
    outH: number,
    feather: number,
): HTMLCanvasElement | null {
    const small = document.createElement('canvas');
    small.width = maskW;
    small.height = maskH;
    const sctx = small.getContext('2d');
    if (!sctx) return null;

    const img = sctx.createImageData(maskW, maskH);
    const d = img.data;
    for (let i = 0; i < mask.length; i++) {
        const on = mask[i] === personLabel ? 255 : 0;
        const j = i * 4;
        d[j] = 255;
        d[j + 1] = 255;
        d[j + 2] = 255;
        d[j + 3] = on;
    }
    sctx.putImageData(img, 0, 0);

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    if (feather > 0) ctx.filter = `blur(${feather}px)`;
    ctx.drawImage(small, -feather, -feather, outW + feather * 2, outH + feather * 2);
    ctx.filter = 'none';
    return out;
}

/** A segmented subject, ready to composite — reusable across frames. */
export interface PortraitMask {
    /** Feathered alpha at the target size: opaque on the subject. */
    alpha: HTMLCanvasElement;
    subjectShare: number;
    /** Subject bounding-box width as a fraction of the frame. */
    subjectWidth: number;
    /** Blur radius this mask was measured for, in pixels. */
    blurRadius: number;
}

/**
 * Segment a frame and turn the result into a feathered alpha mask.
 *
 * Split out of `applyPortrait` so the LIVE preview can reuse one mask across
 * several frames. Segmentation is by far the most expensive thing in this
 * pipeline, and a head does not move far in a tenth of a second — re-running it
 * every frame would spend the whole budget on an answer that barely changed.
 *
 * `mode` must match the segmenter's running mode: `IMAGE` for a one-off
 * capture, `VIDEO` for a stream — which also wants a monotonically increasing
 * `timestamp`, or MediaPipe rejects the frame outright.
 */
export async function segmentToMask(
    source: HTMLCanvasElement,
    { mode = 'IMAGE', timestamp = 0 }: { mode?: Mode; timestamp?: number } = {},
): Promise<PortraitMask | null> {
    const segmenter = await loadSegmenter(mode);
    if (!segmenter) return null;

    const w = source.width;
    const h = source.height;
    if (!w || !h) return null;

    let mask: Uint8Array;
    let maskW: number;
    let maskH: number;
    try {
        const result =
            mode === 'VIDEO'
                ? segmenter.segmentForVideo(source, timestamp)
                : segmenter.segment(source);
        const category = result.categoryMask;
        if (!category) {
            result.close?.();
            return null;
        }
        maskW = category.width;
        maskH = category.height;
        // Copied out before `close()` — the underlying buffer is owned by
        // MediaPipe and reused on the next call.
        mask = new Uint8Array(category.getAsUint8Array());
        result.close?.();
    } catch {
        return null;
    }
    if (!mask.length || !maskW || !maskH) return null;

    /*
     * ── Which label is the person ───────────────────────────────────────────
     *
     * READ, never assumed from label order. Assuming got it backwards once and
     * the pipeline blurred the administrator while leaving their office in
     * perfect focus — which is a funny bug exactly once.
     *
     * The centre of the frame is the person: AWS's oval guarantees the face
     * fills the middle, so a vote over a small central patch is a safe read. A
     * patch rather than one pixel, because a single sample lands on a nostril
     * or a glasses frame often enough to matter.
     */
    const votes = new Map<number, number>();
    const vx0 = Math.floor(maskW * 0.4);
    const vx1 = Math.ceil(maskW * 0.6);
    const vy0 = Math.floor(maskH * 0.3);
    const vy1 = Math.ceil(maskH * 0.5);
    for (let y = vy0; y < vy1; y++) {
        for (let x = vx0; x < vx1; x++) {
            const v = mask[y * maskW + x];
            votes.set(v, (votes.get(v) ?? 0) + 1);
        }
    }
    let personLabel = 0;
    let best = -1;
    for (const [label, n] of votes) {
        if (n > best) {
            best = n;
            personLabel = label;
        }
    }

    // ── Measure the subject ─────────────────────────────────────────────────
    let count = 0;
    let bx0 = maskW;
    let bx1 = -1;
    for (let y = 0; y < maskH; y++) {
        for (let x = 0; x < maskW; x++) {
            if (mask[y * maskW + x] !== personLabel) continue;
            count++;
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
        }
    }

    const subjectShare = count / (maskW * maskH);
    if (
        subjectShare < CAPTURE_PORTRAIT.minSubjectShare ||
        subjectShare > CAPTURE_PORTRAIT.maxSubjectShare
    ) {
        // Not a person in a room — either the whole frame or nothing. The
        // original is better than anything that could be done with this.
        return null;
    }

    /*
     * The subject's width is what every radius below is measured against —
     * failure 3 in the header. Note it is the SEGMENTED subject (head and
     * shoulders), not the face, so `blurRadiusPerFaceWidth` is read against a
     * body width rather than a face width. That is deliberate, and is why the
     * constant is small: shoulders are a far more stable measurement than a
     * face box, which moves with every turn of the head.
     */
    const subjectWidth = bx1 >= bx0 ? (bx1 - bx0 + 1) / maskW : 1;
    const subjectWidthPx = subjectWidth * w;

    const blurRadius = Math.round(
        Math.min(
            CAPTURE_PORTRAIT.blurRadiusMax,
            Math.max(
                CAPTURE_PORTRAIT.blurRadiusMin,
                subjectWidthPx * CAPTURE_PORTRAIT.blurRadiusPerFaceWidth,
            ),
        ),
    );
    const feather = Math.max(
        CAPTURE_PORTRAIT.featherMin,
        Math.round(subjectWidthPx * CAPTURE_PORTRAIT.featherPerFaceWidth),
    );

    const alpha = buildAlphaMask(mask, maskW, maskH, personLabel, w, h, feather);
    if (!alpha) return null;

    return { alpha, subjectShare, subjectWidth, blurRadius };
}

/**
 * Paint a segmented subject over a defocused copy of its own background,
 * in place.
 *
 * Separate from the segmentation so the live loop can run this every frame
 * against a mask computed at a much lower rate. Cheap by comparison: two
 * composites and a GPU blur, with no per-pixel JavaScript at all.
 *
 * ⚠️ A mask computed at a DIFFERENT size than `canvas` still works — the alpha
 * is drawn scaled — but it will be soft in proportion to the difference. The
 * live loop keeps both at the processing resolution so they agree.
 */
export function compositePortrait(canvas: HTMLCanvasElement, mask: PortraitMask): boolean {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || !w || !h) return false;

    // The sharp original, kept before anything is painted over it.
    const sharp = document.createElement('canvas');
    sharp.width = w;
    sharp.height = h;
    sharp.getContext('2d')?.drawImage(canvas, 0, 0);

    // ── 1. The blurred room, in place and edge-clamped ──────────────────────
    const blurred = blurredCopy(sharp, mask.blurRadius);
    if (!blurred) return false;

    ctx.save();
    ctx.drawImage(blurred, 0, 0);

    // ── 2. Depth ────────────────────────────────────────────────────────────
    // Blur alone does not read as portrait mode. A few percent of falloff
    // behind the subject is most of what sells it, and it lands only on the
    // background because the sharp subject goes on top next.
    if (CAPTURE_PORTRAIT.backgroundDim > 0) {
        /*
         * ⚠️ `rgba(r, g, b, a)`, NOT the CSS Color 4 `rgb(0 0 0 / a)` this was
         * written with. Canvas `fillStyle` SILENTLY IGNORES a value it cannot
         * parse and keeps whatever it held before — the default, opaque black.
         * So on any engine that does not accept the space-separated form, a
         * rule meant to darken the background by a tenth instead paints the
         * entire frame solid black. No error, no warning: a black photograph,
         * which is exactly what was reported. The legacy form is universally
         * supported and there is nothing to gain by being modern here.
         */
        ctx.fillStyle = `rgba(0, 0, 0, ${CAPTURE_PORTRAIT.backgroundDim})`;
        ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();

    // ── 3. The sharp subject, masked, over the top ──────────────────────────
    const subject = document.createElement('canvas');
    subject.width = w;
    subject.height = h;
    const sctx = subject.getContext('2d');
    if (!sctx) return false;
    sctx.drawImage(sharp, 0, 0);
    // `destination-in` keeps the subject only where the mask has alpha, and
    // keeps it PARTIALLY where the feather ramps — which is the soft edge.
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(mask.alpha, 0, 0, w, h);
    sctx.globalCompositeOperation = 'source-over';

    ctx.drawImage(subject, 0, 0);

    // ── 4. Vignette ─────────────────────────────────────────────────────────
    // Over everything, subject included — a vignette that stops at the
    // silhouette is a halo. Every phone camera adds one of these.
    if (CAPTURE_PORTRAIT.vignette > 0) {
        const r = Math.hypot(w, h) / 2;
        const grad = ctx.createRadialGradient(w / 2, h / 2, r * 0.55, w / 2, h / 2, r);
        // Legacy `rgba()`, for the reason given at the background dim above.
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        grad.addColorStop(1, `rgba(0, 0, 0, ${CAPTURE_PORTRAIT.vignette})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    return true;
}

/**
 * Apply the portrait look to a still capture, in place.
 *
 * Async because the model load is. Every failure leaves the canvas untouched —
 * see `loadSegmenter` on why that is the only acceptable failure mode here: a
 * real background is a cosmetic disappointment, a mangled capture is a failed
 * sign-in.
 */
export async function applyPortrait(
    canvas: HTMLCanvasElement,
    /**
     * Run even though `CAPTURE_PORTRAIT.enabled` is false.
     *
     * For `/design/capture-lab` and nothing else. The flag exists so the look
     * can be JUDGED before it is switched on — a bench that could only show the
     * stage once someone had already committed to it in config would be useless
     * for the one decision it is there to support. The flow never passes this.
     */
    { force = false }: { force?: boolean } = {},
): Promise<PortraitResult> {
    if (!CAPTURE_PORTRAIT.enabled && !force) return { applied: false, reason: 'no-model' };

    const mask = await segmentToMask(canvas, { mode: 'IMAGE' });
    if (!mask) return { applied: false, reason: 'no-mask' };

    if (!compositePortrait(canvas, mask)) return { applied: false, reason: 'read-failed' };

    return {
        applied: true,
        subjectShare: mask.subjectShare,
        blurRadius: mask.blurRadius,
        subjectWidth: mask.subjectWidth,
    };
}

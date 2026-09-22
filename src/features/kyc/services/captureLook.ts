/**
 * The photographic correction applied to a captured face.
 *
 * Between a camera sensor and the picture you see in a phone's photo library
 * there is a pipeline — black level, exposure, white balance, a tone curve —
 * and it is most of why a phone photograph looks like a photograph while a raw
 * `drawImage(video)` of the same face looks like a webcam still from 2009. This
 * file is that pipeline, in about two hundred lines of canvas work.
 *
 * ── Why it is derived and not dialled in ────────────────────────────────────
 * This was attempted once with fixed constants and reverted (`git log`
 * 554df2b, 5d7f21c): a brightness, a saturation, a smoothing amount, applied to
 * every frame. It looked correct in the room it was tuned in, and wrong in the
 * next one — which is not a bug in the constants, because no constant is right
 * for both an office at noon and a hallway at night.
 *
 * Every amount below is instead MEASURED off the frame and applied as a
 * correction toward a target. The frame says how dark it is; the correction is
 * whatever lands it where a face should sit. A bright frame gets almost
 * nothing. That property — not the specific numbers — is what makes this
 * survivable, and `config/capture.ts` says the same thing at more length.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * No skin smoothing, no reshaping, no relighting, no invented detail of any
 * kind. This image is what CompareFaces is given at `face-match` and what sits
 * on an identity record. Exposure and colour are corrections — the sensor
 * recorded a face and this presents it properly. Retouching would be an
 * assertion about someone's face, which is a different thing and belongs
 * nowhere near a KYC flow.
 */

import { CAPTURE_TONE } from '@/features/kyc/config/capture';

/** Rec. 601 luma — the same weights `imageQuality.ts` uses, kept consistent. */
function luma(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** What one frame needs, measured off that frame. */
export interface ToneAnalysis {
    /** Input level mapped to black, 0..255. */
    black: number;
    /** Input level mapped to white, 0..255. */
    white: number;
    /** Exposure multiplier applied after the levels stretch. */
    exposure: number;
    /** Per-channel white-balance gains, already damped and clamped. */
    gain: { r: number; g: number; b: number };
    /** Mean luma of the metered region before correction, 0..1 — for the bench. */
    faceLuma: number;
    /** True when the frame was too flat to stretch — see `maxBlackLift`. */
    flat: boolean;
}

/**
 * A rectangle to meter the exposure over, in 0..1 of the image.
 *
 * Phone cameras meter for the FACE, not the scene, which is why a backlit
 * portrait comes out with a visible face and a blown window rather than a
 * silhouette against a correct-looking window. Pass the face box when one is
 * known.
 */
export interface MeterRegion {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * The default metering region when no face box is available.
 *
 * The centre 50% x 60%, which on this screen is where the face is — the oval
 * AWS enforces guarantees it. Metering the whole frame instead would let a
 * bright wall behind the subject decide the exposure, and the person would be
 * darkened to compensate. That is exactly the backlit-silhouette failure.
 */
const DEFAULT_METER: MeterRegion = { x: 0.25, y: 0.2, w: 0.5, h: 0.6 };

/**
 * Measure what this frame needs.
 *
 * Runs on a downsample rather than the full image: a histogram does not get
 * more accurate with more pixels once there are tens of thousands of them, and
 * this has to be cheap enough to run on every capture on a phone.
 */
export function analyseTone(
    source: HTMLCanvasElement | HTMLVideoElement | ImageBitmap,
    meter: MeterRegion = DEFAULT_METER,
): ToneAnalysis | null {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sw || !sh) return null;

    const w = Math.max(32, Math.min(160, sw));
    const h = Math.max(32, Math.round((w * sh) / sw));

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);

    let img: ImageData;
    try {
        img = ctx.getImageData(0, 0, w, h);
    } catch {
        // A tainted canvas. Same-origin stream, so it should not happen — and a
        // missing correction must never break a capture.
        return null;
    }
    const d = img.data;

    // ── Histogram over the whole frame, for the black and white points ──────
    // Whole frame, deliberately: the levels stretch describes the PICTURE, and
    // clipping decided from the face alone would blow the room around it.
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
        hist[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    }
    const total = d.length / 4;

    const percentile = (p: number): number => {
        const want = total * p;
        let seen = 0;
        for (let v = 0; v < 256; v++) {
            seen += hist[v];
            if (seen >= want) return v;
        }
        return 255;
    };

    let black = percentile(CAPTURE_TONE.blackPercentile);
    let white = percentile(CAPTURE_TONE.whitePercentile);

    /*
     * Refuse to stretch a frame that has nothing to stretch.
     *
     * A picture genuinely occupying 40..210 becomes a photograph when pulled to
     * full range. A picture occupying 118..134 is fog, and pulling THAT to full
     * range produces posterised banding — sixteen input levels smeared across
     * two hundred and fifty-six output ones — which looks far worse than the
     * flat frame it replaced. The caps are where that line sits.
     */
    const flat = black > CAPTURE_TONE.maxBlackLift || white < 255 - CAPTURE_TONE.maxWhitePull;
    black = Math.min(black, CAPTURE_TONE.maxBlackLift);
    white = Math.max(white, 255 - CAPTURE_TONE.maxWhitePull);
    if (white - black < 16) {
        // Degenerate. Leave the levels alone; exposure below can still help.
        black = 0;
        white = 255;
    }

    // ── Meter the face region for exposure ──────────────────────────────────
    const mx0 = Math.max(0, Math.floor(meter.x * w));
    const my0 = Math.max(0, Math.floor(meter.y * h));
    const mx1 = Math.min(w, Math.ceil((meter.x + meter.w) * w));
    const my1 = Math.min(h, Math.ceil((meter.y + meter.h) * h));

    let meterSum = 0;
    let meterN = 0;
    // Channel sums for grey-world, taken over the SAME region. Whole-frame
    // grey-world would be decided by the wall behind the subject.
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;

    for (let y = my0; y < my1; y++) {
        for (let x = mx0; x < mx1; x++) {
            const i = (y * w + x) * 4;
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            meterSum += luma(r, g, b);
            rSum += r;
            gSum += g;
            bSum += b;
            meterN++;
        }
    }
    if (!meterN) return null;

    const faceLuma = meterSum / meterN / 255;

    /*
     * Exposure is computed AFTER the levels stretch, not before.
     *
     * The stretch already moves the midtones — lifting the black point pulls
     * everything up with it — so metering the raw frame and then also
     * stretching double-corrects, and a dim capture comes out bright and
     * washed. Predicting where the meter lands after the stretch and correcting
     * from THERE is the difference between one correction and two.
     */
    const span = white - black;
    const stretchedLuma = span > 0 ? Math.min(1, Math.max(0, (faceLuma * 255 - black) / span)) : faceLuma;

    /*
     * ── Exposure is a GAMMA, not a multiplier ───────────────────────────────
     *
     * This was `target / stretched` — a linear gain — and it was wrong in a way
     * that only shows up on the frames it is most needed for. A dim capture
     * metering at 0.30 asks for a gain of 1.8, and a linear 1.8x sends input
     * level 128 to 249 and clips EVERYTHING above about 135 to pure white. The
     * correction meant to rescue a dark photograph instead blows out every
     * highlight in it: a lamp, a window, a lit forehead, all one flat white
     * shape. Checked numerically before it shipped — half the input range
     * collapsed onto a single output level.
     *
     * A gamma cannot do that. `x^(1/E)` fixes both endpoints — black stays
     * black, white stays white — and lifts only what is between them, which is
     * where a face lives. It is also what a camera's own brightness control is.
     *
     * Solving `stretched^(1/E) = target` for E gives `ln(stretched)/ln(target)`,
     * so the same "land the face where a face belongs" intent is preserved
     * exactly; only the shape of the correction changed.
     */
    const exposure = Math.min(
        CAPTURE_TONE.exposureMax,
        Math.max(
            CAPTURE_TONE.exposureMin,
            stretchedLuma > 0.01 && stretchedLuma < 0.999
                ? Math.log(stretchedLuma) / Math.log(CAPTURE_TONE.targetFaceLuma)
                : 1,
        ),
    );

    // ── Grey-world white balance, damped ────────────────────────────────────
    /*
     * The assumption is that the scene averages to neutral, and here it
     * measurably does not: a face fills the metering region and skin is warm.
     * A full correction therefore reads the SUBJECT as a colour cast and cools
     * the person to a corpse — which is what "washed out" usually turns out to
     * mean when someone says a webcam photo looks bad.
     *
     * `whiteBalance` (0.4) is how much of the correction to believe. It is
     * enough to kill the green of an office fluorescent or the orange of a
     * table lamp, and not enough to argue with the fact that there is a person
     * in the picture.
     */
    const mean = (rSum + gSum + bSum) / (3 * meterN);
    const rawGain = {
        r: rSum > 0 ? (mean * meterN) / rSum : 1,
        g: gSum > 0 ? (mean * meterN) / gSum : 1,
        b: bSum > 0 ? (mean * meterN) / bSum : 1,
    };

    const damp = (x: number) =>
        Math.min(
            CAPTURE_TONE.whiteBalanceMaxGain,
            Math.max(1 / CAPTURE_TONE.whiteBalanceMaxGain, 1 + (x - 1) * CAPTURE_TONE.whiteBalance),
        );

    return {
        black,
        white,
        exposure,
        gain: { r: damp(rawGain.r), g: damp(rawGain.g), b: damp(rawGain.b) },
        faceLuma,
        flat,
    };
}

/**
 * Build the 256-entry lookup table for one channel.
 *
 * A LUT rather than per-pixel arithmetic: every operation here is a pure
 * function of the input level, so there are only 256 distinct answers per
 * channel. Computing them once and indexing turns a five-step chain over two
 * million pixels into two hundred and fifty-six evaluations and a lookup.
 */
function buildLut(tone: ToneAnalysis, channelGain: number, warmth: number): Uint8ClampedArray {
    const lut = new Uint8ClampedArray(256);
    const span = Math.max(1, tone.white - tone.black);

    for (let v = 0; v < 256; v++) {
        // 1. Levels — map [black, white] onto [0, 1].
        let x = (v - tone.black) / span;
        x = Math.min(1, Math.max(0, x));

        // 2. Exposure, as a gamma. `x^(1/E)` pins 0 to 0 and 1 to 1 and lifts
        //    only the middle, so it CANNOT clip — see the long note at the
        //    solve in `analyseTone` for why the linear multiply this replaced
        //    was blowing every highlight out of a dark frame.
        //
        //    Applied before the curve so the curve's toe and shoulder act on
        //    the corrected image rather than on the sensor's.
        if (tone.exposure !== 1) x = Math.pow(x, 1 / tone.exposure);

        // 3. The S-curve. `x + k * sin(2πx) / 2π` is a smooth curve through
        //    (0,0) and (1,1) that lifts the upper midtones and drops the lower
        //    ones — a film-like response with no clipping and no inflection to
        //    tune. A pure cubic would pin the contrast increase to the exact
        //    middle, which on a face lands on the cheek.
        const k = CAPTURE_TONE.sCurve;
        if (k > 0) x = Math.min(1, Math.max(0, x - (k * Math.sin(2 * Math.PI * x)) / (2 * Math.PI)));

        // 4. White balance.
        x *= channelGain;

        // 5. Warmth, weighted to the midtones — `4x(1-x)` peaks at 0.5 and
        //    vanishes at both ends, so highlights stay neutral and shadows do
        //    not go muddy.
        const mid = 4 * x * (1 - x);
        lut[v] = Math.round(Math.min(255, Math.max(0, x * 255 + warmth * mid)));
    }
    return lut;
}

/**
 * Apply a measured correction to a canvas, in place.
 *
 * Returns false when the pixels could not be read (a tainted canvas), which
 * callers treat as "leave the capture alone" rather than as a failure.
 */
export function applyTone(canvas: HTMLCanvasElement, tone: ToneAnalysis): boolean {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !canvas.width || !canvas.height) return false;

    let img: ImageData;
    try {
        img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
        return false;
    }

    const lutR = buildLut(tone, tone.gain.r, CAPTURE_TONE.warmth);
    const lutG = buildLut(tone, tone.gain.g, 0);
    const lutB = buildLut(tone, tone.gain.b, -CAPTURE_TONE.warmth);

    const d = img.data;
    // Widened from the `as const` literal so the `=== 1` fast path below is a
    // runtime check rather than a compile-time impossibility.
    const sat: number = CAPTURE_TONE.saturation;

    for (let i = 0; i < d.length; i += 4) {
        const r = lutR[d[i]];
        const g = lutG[d[i + 1]];
        const b = lutB[d[i + 2]];

        if (sat === 1) {
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
            continue;
        }

        /*
         * Saturation around the pixel's own luma, not around grey.
         *
         * Scaling the channels themselves would change brightness as well as
         * colour and undo the exposure work above. Pushing each channel away
         * from the pixel's luminance moves only the colour.
         *
         * Most of what this does is restore what the levels stretch took:
         * pulling the channels apart around a shared midpoint desaturates, so
         * 1.06 is closer to "put it back" than to "add colour".
         */
        const l = luma(r, g, b);
        d[i] = l + (r - l) * sat;
        d[i + 1] = l + (g - l) * sat;
        d[i + 2] = l + (b - l) * sat;
    }

    ctx.putImageData(img, 0, 0);
    return true;
}

/**
 * Measure and correct in one call — what every caller actually wants.
 *
 * Fails soft in every direction: no analysis, no correction, original canvas
 * untouched. Returns what was applied so the bench can print it.
 */
export function enhanceCapture(
    canvas: HTMLCanvasElement,
    meter?: MeterRegion,
): ToneAnalysis | null {
    if (!CAPTURE_TONE.enabled) return null;
    const tone = analyseTone(canvas, meter);
    if (!tone) return null;
    return applyTone(canvas, tone) ? tone : null;
}

/**
 * The face box as a metering region, from MediaPipe's normalised landmarks.
 *
 * ⚠️ NOTHING CALLS THIS YET, and that is worth stating rather than leaving to
 * be discovered. Neither capture path has a face box to give it: AWS does not
 * surface its own detection, and the single-frame screen's gate holds the
 * landmarks but does not thread them to the capture. Both therefore meter
 * `DEFAULT_METER`, which AWS's oval makes a good guess.
 *
 * It is here because it is the obvious next improvement if exposure is ever
 * wrong on a face that is off-centre — `useFaceLandmarker` already produces
 * exactly the input it wants, in `FaceScanScreen`'s gate.
 */
export function meterFromLandmarks(
    points: { x: number; y: number }[] | undefined,
): MeterRegion | undefined {
    if (!points?.length) return undefined;

    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;
    for (const p of points) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
    }
    if (x1 <= x0 || y1 <= y0) return undefined;

    /*
     * Shrunk 15% toward the centre.
     *
     * The landmark hull includes the jaw and hairline, and both sit against
     * whatever is behind the head — so metering the full box lets the
     * background back into the exposure decision through the corners. The inner
     * box is face.
     */
    const inset = 0.15;
    const w = x1 - x0;
    const h = y1 - y0;
    return {
        x: x0 + w * inset,
        y: y0 + h * inset,
        w: w * (1 - inset * 2),
        h: h * (1 - inset * 2),
    };
}

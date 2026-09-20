'use client';

import type { ImageSegmenter } from '@mediapipe/tasks-vision';

/**
 * Turns a captured camera frame into a portrait: the person kept sharp, the
 * background softened around them and falling further out of focus toward the
 * edges, the way a phone's portrait mode does it.
 *
 * ── Why the background goes ─────────────────────────────────────────────────
 * The frame is taken wherever the administrator happens to be sitting, so it
 * carries their room with it — and that room is then on screen during the
 * check and in the record afterwards. A matte makes every capture look like
 * the same deliberate portrait instead of a webcam still, and it removes the
 * one part of the picture that had no business being kept.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It does not touch the face. Tone, smoothing, "beauty" — none of that is
 * baked in here. Those are a CSS filter applied where the image is DISPLAYED
 * (`BEAUTY_FILTER_CSS` below), and the reason is not taste: this same image is
 * what CompareFaces is given at `face-match`. Retouched skin is a face the
 * comparison was not asked about.
 *
 * Matting is a different kind of edit and is safe for that purpose — it
 * replaces pixels that are NOT the person. Rekognition reads facial geometry;
 * a clean background is, if anything, the easier input.
 *
 * ── It fails soft, always ───────────────────────────────────────────────────
 * Every failure path returns the original frame untouched: no model, no WebGL,
 * a segmentation that looks wrong. A capture with its real background behind
 * it is a cosmetic disappointment. A capture that is blank, or one with half a
 * jaw cut off, is a failed sign-in — so anything short of confident goes
 * through unchanged.
 */

const MEDIAPIPE_BASE_URL = '/vendor/mediapipe';
const SELFIE_MODEL_PATH = '/vendor/mediapipe/selfie_segmenter.tflite';

/**
 * Sanity band for how much of the frame the mask claims is a person.
 *
 * A face at the distance this check demands fills a lot of the picture, but
 * never all of it and never almost none of it. Outside this band the
 * segmentation has misread the scene — a blown-out window read as foreground,
 * or a dark room read as empty — and matting on that would either erase the
 * administrator or keep the room and erase nothing.
 */
const MIN_COVERAGE = 0.08;
const MAX_COVERAGE = 0.95;

/**
 * How much the mask edge is softened, as a fraction of image width.
 *
 * The model returns a hard per-pixel category, and a hard edge against a flat
 * backdrop is what makes a cut-out look cut out — jagged around hair especially.
 * Blurring the mask before it is used as alpha trades a little accuracy at the
 * silhouette for an edge that reads as a photograph.
 */
const FEATHER_RATIO = 0.006;

/**
 * The backdrop: the real background, thrown out of focus.
 *
 * ── Why bokeh and not a replacement ─────────────────────────────────────────
 * A flat fill and then a studio sweep were both tried, and both had the same
 * problem: they are a different picture behind the subject, so the mask edge
 * is a seam between two unrelated images. At 640x480 that seam is exactly
 * where segmentation is least certain — hair, shoulders, the gap under a chin
 * — and a hard-edged silhouette against a clean backdrop shows every pixel of
 * it.
 *
 * Blurring what was actually there removes the room without introducing a
 * second image. The colours behind the subject stay the colours that were
 * behind them, so an imperfect edge blends into something that nearly matches
 * instead of cutting against it. It is also what a phone's portrait mode does,
 * which is the look this was asked for.
 *
 * ── Why it ramps rather than sitting at one strength ────────────────────────
 * A single blur across the whole background is the thing that reads as "too
 * much": it is strongest right at the subject's shoulder, where the eye is
 * already looking, and it flattens the frame into two layers with a hard
 * boundary between them.
 *
 * A lens does not do that. Focus falls off with distance, and in a room the
 * far corners are further away than the wall immediately behind someone's
 * head. So the blur starts gentle around the subject and builds toward the
 * edges, which both looks like depth and puts the strongest effect furthest
 * from the mask edge — the part most likely to be imperfect.
 *
 * Both radii are fractions of image width, so the strength is the same
 * whatever the capture resolution turns out to be.
 */
const BACKDROP_BLUR_MIN_RATIO = 0.006;
const BACKDROP_BLUR_MAX_RATIO = 0.018;

/**
 * Where the ramp begins, as a fraction of the distance to the far corner.
 *
 * Inside this the background stays at the gentle blur, which keeps the area
 * immediately around the head calm.
 */
const BACKDROP_FOCUS_STOP = 0.42;

/**
 * How far above the subject's centroid the focus is centred, as a fraction of
 * image height.
 *
 * A person's centroid includes their shoulders, so it sits low; centring the
 * sharp zone there would start blurring at head height.
 */
const BACKDROP_LIFT = 0.1;

/**
 * How far past the frame the blurred copy is drawn, as a fraction of size.
 *
 * A blur samples beyond its source, so a blurred image drawn at exactly the
 * canvas size fades toward transparent at all four edges and the result has a
 * pale border. Drawing it slightly oversized puts that falloff outside the
 * frame, where it is cropped away.
 */
const BACKDROP_OVERSCAN = 0.14;

/**
 * A touch of lift and desaturation on the background only.
 *
 * Not a look — separation. A blurred background at exactly the subject's
 * brightness still competes with them; pushing it slightly lighter and less
 * colourful is what makes the face read as the thing in focus rather than the
 * thing in front.
 */
const BACKDROP_BRIGHTNESS = 1.12;
const BACKDROP_SATURATION = 0.82;

/**
 * Closing the person-shaped hole left in the background.
 *
 * Each pass draws a shrunken copy of the background underneath itself, so the
 * room creeps inward over the hole. `STEP` is how much is taken off per pass
 * and `PASSES` how many times; together they shrink the hole to roughly
 * `STEP ** PASSES` of its original size, which at these values is about a
 * fifth — well past the point where the blur that follows can tell.
 */
const BG_FILL_STEP = 0.82;
const BG_FILL_PASSES = 8;

/** The shadow, also in fractions of image width so it scales with the frame. */
const SHADOW_BLUR_RATIO = 0.03;
const SHADOW_OFFSET_RATIO = 0.008;
/*
 * Lighter than it was against a flat backdrop. A shadow is how a cut-out is
 * grounded on a surface it was never on; against a blurred version of the real
 * scene there is no surface to sell, and a strong one reads as pasted. This is
 * just enough edge separation for a subject whose background happens to be the
 * same tone as they are. Set the alpha to 0 to take it out entirely.
 */
const SHADOW_COLOR = 'rgba(0, 0, 0, 0.16)';

/** Matches the frame quality elsewhere in this flow — see LivenessCamera. */
const JPEG_QUALITY = 0.92;

/**
 * The look applied when this image is SHOWN. Never baked into the file.
 *
 * Paired with `BEAUTY_SOFT_*`: a blurred copy of the same image laid over the
 * sharp one at partial opacity. A plain `blur()` would soften the eyes and
 * mouth along with the skin and read as a smeared photograph; layering keeps
 * the original's edges underneath and lets the blur fill in texture only.
 *
 * ⚠️ `contrast` moves DOWN as the others move up, which looks like a mistake
 * and is not. Contrast is what re-asserts the skin texture the soft layer is
 * there to suppress, so turning smoothing up while leaving contrast alone gets
 * a face that is both blurred and harsh. Raising brightness and saturation
 * instead is what keeps it from also going flat.
 */
export const BEAUTY_FILTER_CSS = 'brightness(1.13) contrast(1.01) saturate(1.2)';
/** Blur radius of the soft layer, in XD px (see AGENTS.md §1). */
export const BEAUTY_SOFT_BLUR = 5;
/** Opacity of that layer. */
export const BEAUTY_SOFT_OPACITY = 0.42;

let cached: ImageSegmenter | null = null;
let loadPromise: Promise<ImageSegmenter | null> | null = null;

async function loadSegmenter(): Promise<ImageSegmenter | null> {
    if (cached) return cached;
    try {
        const vision = await import('@mediapipe/tasks-vision');
        const { ImageSegmenter: Segmenter, FilesetResolver } = vision;
        const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_BASE_URL);
        cached = await Segmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: SELFIE_MODEL_PATH, delegate: 'GPU' },
            runningMode: 'IMAGE',
            outputCategoryMask: true,
            outputConfidenceMasks: false,
        });
        return cached;
    } catch (err) {
        // Never rethrown. A missing model is why `sync-vendor` prints what it
        // prints; here it just means the frame keeps its background.
        console.warn('[portrait] segmenter unavailable — keeping real background', err);
        return null;
    }
}

/**
 * Start loading the model now.
 *
 * Worth calling as the camera opens: the matte happens at the moment the check
 * finishes, which is the one moment in this flow where the user is already
 * waiting on a server and a cold model would be felt.
 */
export function kickstartPortrait(): void {
    loadPromise ??= loadSegmenter();
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

/**
 * Separate the person in `dataUrl` from their background and blur the latter.
 *
 * Returns the original string unchanged on any failure — see the header.
 */
export async function toPortrait(dataUrl: string): Promise<string> {
    try {
        loadPromise ??= loadSegmenter();
        const segmenter = await loadPromise;
        if (!segmenter) return dataUrl;

        const img = await loadImage(dataUrl);
        const w = img?.naturalWidth ?? 0;
        const h = img?.naturalHeight ?? 0;
        if (!img || !w || !h) return dataUrl;

        const result = segmenter.segment(img);
        const mask = result.categoryMask;
        if (!mask) return dataUrl;

        // Copied before the mask is closed: the underlying buffer belongs to
        // the task and is not ours to hold on to.
        const cats = new Uint8Array(mask.getAsUint8Array());
        const mw = mask.width;
        const mh = mask.height;
        mask.close();

        /*
         * ── Which category is the person ────────────────────────────────────
         *
         * Read from the picture, not assumed from the label order. Hardcoding
         * "category 0 is background" is what shipped first, and it produced the
         * exact inverse: a white silhouette of the administrator with their
         * room intact around it.
         *
         * The centre of the frame is the reliable tell, and it is reliable
         * precisely because of the check this runs inside — AWS will not accept
         * a face that is not filling a large, centred oval, so by the time
         * there is a frame to matte, the middle of it is a face. Whatever
         * category holds that centre is the subject, whichever index the model
         * happens to give it.
         */
        const cx0 = Math.floor(mw * 0.35);
        const cx1 = Math.ceil(mw * 0.65);
        const cy0 = Math.floor(mh * 0.35);
        const cy1 = Math.ceil(mh * 0.65);
        const centreCounts = new Map<number, number>();
        for (let y = cy0; y < cy1; y += 1) {
            for (let x = cx0; x < cx1; x += 1) {
                const c = cats[y * mw + x];
                centreCounts.set(c, (centreCounts.get(c) ?? 0) + 1);
            }
        }
        let personCat = 0;
        let best = -1;
        centreCounts.forEach((count, cat) => {
            if (count > best) {
                best = count;
                personCat = cat;
            }
        });

        // Coverage and centroid in one pass — the centroid is where the blur
        // ramp is centred, so the calm zone sits around whoever is in the frame
        // rather than around the middle of it.
        let person = 0;
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < cats.length; i += 1) {
            if (cats[i] !== personCat) continue;
            person += 1;
            sumX += i % mw;
            sumY += (i / mw) | 0;
        }
        const coverage = person / cats.length;
        if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) {
            console.warn(
                `[portrait] mask covers ${(coverage * 100).toFixed(0)}% — outside the sane band, keeping original`,
            );
            return dataUrl;
        }

        // ── The mask, as an alpha channel ──────────────────────────────────
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = mw;
        maskCanvas.height = mh;
        const mctx = maskCanvas.getContext('2d');
        if (!mctx) return dataUrl;
        const alpha = mctx.createImageData(mw, mh);
        for (let i = 0; i < cats.length; i += 1) {
            const p = i * 4;
            alpha.data[p] = 255;
            alpha.data[p + 1] = 255;
            alpha.data[p + 2] = 255;
            // Opaque where the subject is, transparent everywhere else — so
            // the white below shows through the background, not through them.
            alpha.data[p + 3] = cats[i] === personCat ? 255 : 0;
        }
        mctx.putImageData(alpha, 0, 0);

        // Scaled to the frame and feathered in one draw. The mask comes back at
        // the model's own resolution, which is smaller than the frame.
        const soft = document.createElement('canvas');
        soft.width = w;
        soft.height = h;
        const sctx = soft.getContext('2d');
        if (!sctx) return dataUrl;
        sctx.filter = `blur(${Math.max(1, Math.round(w * FEATHER_RATIO))}px)`;
        sctx.drawImage(maskCanvas, 0, 0, w, h);

        // ── The subject, with everything else erased ───────────────────────
        const subject = document.createElement('canvas');
        subject.width = w;
        subject.height = h;
        const cctx = subject.getContext('2d');
        if (!cctx) return dataUrl;
        cctx.drawImage(img, 0, 0);
        cctx.globalCompositeOperation = 'destination-in';
        cctx.drawImage(soft, 0, 0);
        cctx.globalCompositeOperation = 'source-over';

        // ── The background, with the subject taken OUT of it ───────────────
        //
        // ⚠️ This is what stops the double-face. Blurring the whole frame and
        // drawing the sharp subject over it leaves the subject IN the blurred
        // layer too — a second, softer copy of the same head sitting directly
        // behind the real one. Drawn oversized for the blur's edge falloff, that
        // copy is also magnified, so it reads as a larger face looming behind
        // the face. At a heavy blur it was mush and invisible; the moment the
        // blur came down to something tasteful it became the most obvious thing
        // in the picture.
        //
        // So the subject is cut out of the background before anything is
        // blurred. What is blurred is then only ever the room.
        const bg = document.createElement('canvas');
        bg.width = w;
        bg.height = h;
        const bctx = bg.getContext('2d');
        if (!bctx) return dataUrl;
        bctx.drawImage(img, 0, 0);
        bctx.globalCompositeOperation = 'destination-out';
        bctx.drawImage(soft, 0, 0);

        // That leaves a person-shaped hole. Left empty it blurs into a dark
        // smear — the same halo by another route — so it is closed by pulling
        // the surrounding room inward: each pass paints a slightly shrunken
        // copy of what is there UNDER what is there, so background colours
        // creep in from the edges of the hole. It is a crude inpaint and does
        // not need to be better than crude, because a blur is the next thing
        // that happens to it.
        bctx.globalCompositeOperation = 'destination-over';
        for (let i = 0; i < BG_FILL_PASSES; i += 1) {
            const k = BG_FILL_STEP;
            bctx.drawImage(bg, (w - w * k) / 2, (h - h * k) / 2, w * k, h * k);
        }
        bctx.globalCompositeOperation = 'source-over';

        // ── The backdrop, then the shadow and the subject in one draw ──────
        //
        // Canvas casts a shadow from the alpha of whatever is drawn, so the
        // silhouette gets one for free and it is the real outline rather than a
        // box around the image.
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const octx = out.getContext('2d');
        if (!octx) return dataUrl;

        // The room, out of focus and drawn oversized so the blur's own edge
        // falloff lands outside the crop. Safe to magnify now that the subject
        // is not in it — a slightly enlarged room is not something anyone can
        // see.
        //
        // ⚠️ `ctx.filter` is unsupported on Safari before 17, where the
        // assignment is simply ignored. The background then stays sharp and the
        // result is the original picture with a shadowed subject over it —
        // unremarkable rather than broken, which is the right way for this to
        // fail.
        const ow = w * (1 + BACKDROP_OVERSCAN);
        const oh = h * (1 + BACKDROP_OVERSCAN);
        const drawBackground = (target: CanvasRenderingContext2D, blurPx: number) => {
            target.filter =
                `blur(${blurPx}px) brightness(${BACKDROP_BRIGHTNESS}) ` +
                `saturate(${BACKDROP_SATURATION})`;
            target.drawImage(bg, (w - ow) / 2, (h - oh) / 2, ow, oh);
            target.filter = 'none';
        };

        // Where the frame is calmest: on the subject, lifted toward the head,
        // and clamped so an odd centroid cannot push it off the picture.
        const fx = Math.min(Math.max((sumX / person) * (w / mw), w * 0.25), w * 0.75);
        const fy = Math.min(
            Math.max((sumY / person) * (h / mh) - h * BACKDROP_LIFT, h * 0.2),
            h * 0.6,
        );
        const reach = Math.max(
            Math.hypot(fx, fy),
            Math.hypot(w - fx, fy),
            Math.hypot(fx, h - fy),
            Math.hypot(w - fx, h - fy),
        );

        // The gentle blur, everywhere.
        drawBackground(octx, Math.max(1, Math.round(w * BACKDROP_BLUR_MIN_RATIO)));

        // The strong blur, faded in from `BACKDROP_FOCUS_STOP` outward. Two
        // layers and a mask, rather than one blur per ring: a real gradient of
        // blur radius is not something canvas can express, and stacking rings
        // would band.
        const far = document.createElement('canvas');
        far.width = w;
        far.height = h;
        const fctx = far.getContext('2d');
        if (fctx) {
            drawBackground(fctx, Math.max(2, Math.round(w * BACKDROP_BLUR_MAX_RATIO)));
            const ramp = fctx.createRadialGradient(
                fx,
                fy,
                reach * BACKDROP_FOCUS_STOP,
                fx,
                fy,
                reach,
            );
            ramp.addColorStop(0, 'rgba(0, 0, 0, 0)');
            ramp.addColorStop(1, 'rgba(0, 0, 0, 1)');
            fctx.globalCompositeOperation = 'destination-in';
            fctx.fillStyle = ramp;
            fctx.fillRect(0, 0, w, h);
            fctx.globalCompositeOperation = 'source-over';
            octx.drawImage(far, 0, 0);
        }

        octx.shadowColor = SHADOW_COLOR;
        octx.shadowBlur = Math.round(w * SHADOW_BLUR_RATIO);
        octx.shadowOffsetY = Math.round(w * SHADOW_OFFSET_RATIO);
        octx.drawImage(subject, 0, 0);

        return out.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch (err) {
        console.warn('[portrait] matting failed — keeping original frame', err);
        return dataUrl;
    }
}

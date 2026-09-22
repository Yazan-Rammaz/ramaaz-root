/**
 * Turning a live video frame into the photograph the flow files.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * Because the bench has to run the SAME pipeline the sign-in runs, and the only
 * way to guarantee that is for both to call one function. The first attempt at
 * improving this capture put the processing inside `LivenessCamera` and the
 * judging inside the design gallery, which meant the bench was measuring a
 * near-copy — and "it looked fine when I checked it" was true and worthless at
 * the same time. `/design/capture-lab` imports `processFrame`; so does
 * `LivenessCamera`. Tuning one tunes both, and there is nothing to drift.
 *
 * ── Two images out, not one ─────────────────────────────────────────────────
 * `stored` goes to the backend and to CompareFaces. `display` goes on screen.
 * They are usually the same string; they diverge when an edit is worth showing
 * but not worth submitting — portrait blur, by default. `config/capture.ts`
 * (`CAPTURE_OUTPUT`) is where that is decided and argued.
 */

import {
    CAPTURE_FRAMING,
    CAPTURE_OUTPUT,
    CAPTURE_PORTRAIT,
    CAPTURE_TONE,
} from '@/features/kyc/config/capture';
import { analyseTone, applyTone, type MeterRegion, type ToneAnalysis } from './captureLook';
import { applyLook, type LookResult } from './look';
import { applyPortrait, type PortraitResult } from './portrait';
import { computeBrightness, computeSharpness, getDownsampledImageData } from './imageQuality';

export interface FaceCapture {
    /** JPEG data URL submitted to the backend and given to CompareFaces. */
    stored: string;
    /** JPEG data URL shown on screen. The same string as `stored` unless an
     *  edit was applied for display only. */
    display: string;
    /** What the tone pass measured, or null when it was off or could not read. */
    tone: ToneAnalysis | null;
    /**
     * What the beauty pass did. DISPLAY ONLY — it is never in `stored`, by
     * design and permanently; see `CAPTURE_OUTPUT.bakeBeauty`.
     */
    /**
     * What the look pass did — skin smoothing and portrait lighting, in one
     * traversal. DISPLAY ONLY: it is never in `stored`, by design and
     * permanently. See `CAPTURE_OUTPUT.bakeBeauty`.
     */
    look: LookResult | null;
    /** What the portrait pass did, or null when it was off. */
    portrait: PortraitResult | null;
    /** Pixel size of the captured frame — the honest measure of sharpness. */
    width: number;
    height: number;
    /** Approximate size of `stored` on the wire. */
    storedBytes: number;
}

/** Copy a canvas, because every stage here needs an untouched original. */
function copyOf(src: HTMLCanvasElement): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    out.getContext('2d')?.drawImage(src, 0, 0);
    return out;
}

/**
 * Pull the current frame out of a video element.
 *
 * ── On cropping, and why it stopped ─────────────────────────────────────────
 * This used to centre-crop the sensor's 4:3 frame to the viewfinder's 0.875
 * before storing it, on the argument that the file should match what the user
 * was looking at. It did match — and it threw away 34% of the width to do it,
 * which on this screen is the entire head-room and both shoulders. "It is a
 * face and nothing else" was partly AWS's oval and partly this.
 *
 * `CAPTURE_FRAMING.keepFullFrame` keeps the sensor frame and lets the 350x400
 * box crop it at display with `object-fit: cover`. The on-screen result is
 * identical to the pixel — the preview was always a cover-crop of the same
 * stream — and the stored photograph is no longer pre-trimmed to the tightest
 * crop any screen will ever want.
 */
export function grabFrame(
    video: HTMLVideoElement,
    /**
     * A canvas to draw into instead of allocating one.
     *
     * ⚠️ PASS THIS from any per-frame loop. A capture is now the full sensor
     * frame at 1280x960 — about 4.9MB of backing store — and a poll that
     * allocates a fresh one five times a second hands the browser a quarter of
     * a gigabyte of short-lived canvases over a ten-second check. Chrome
     * responds by discarding backing stores, and a discarded canvas reads as
     * fully transparent, which encodes to a BLACK JPEG.
     *
     * That is not hypothetical: it is exactly what this function did when it
     * first replaced the inline crop, and a black captured photo was the
     * symptom. The code it replaced reused one canvas, which is also what hid
     * the blank-frame case described below.
     */
    reuse?: HTMLCanvasElement | null,
): HTMLCanvasElement | null {
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    if (!sw || !sh) return null;

    /*
     * HAVE_CURRENT_DATA or better.
     *
     * `drawImage` from a video with no decoded frame does not throw — it draws
     * NOTHING and leaves the destination untouched. On a reused canvas that is
     * invisible, because the previous frame is still there. On a fresh one it
     * is a transparent canvas, and `toDataURL('image/jpeg')` renders
     * transparency as black. Both paths are guarded here rather than relying on
     * the reuse to paper over it.
     */
    if (video.readyState < 2) return null;

    const canvas = reuse ?? document.createElement('canvas');

    const aspect = CAPTURE_FRAMING.displayAspect;
    const targetW = CAPTURE_FRAMING.keepFullFrame ? sw : Math.round(Math.min(sw, sh * aspect));
    const targetH = CAPTURE_FRAMING.keepFullFrame ? sh : Math.round(Math.min(sh, sw / aspect));

    // Assigning width/height CLEARS the canvas, so only do it when it actually
    // changed — otherwise every call throws away the frame it is about to
    // replace and a failed draw leaves a blank.
    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    try {
        if (CAPTURE_FRAMING.keepFullFrame) {
            ctx.drawImage(video, 0, 0);
        } else {
            ctx.drawImage(
                video,
                (sw - targetW) / 2,
                (sh - targetH) / 2,
                targetW,
                targetH,
                0,
                0,
                targetW,
                targetH,
            );
        }
    } catch {
        // A tainted canvas would throw. Same-origin stream, so it should not —
        // and a missing still must never break the check.
        return null;
    }

    return canvas;
}

/**
 * Is there actually a picture in here?
 *
 * Cheap, and the last line of defence against filing a black photograph. A
 * canvas whose backing store was discarded, or that a no-op `drawImage` left
 * untouched, is uniformly transparent — so it has no brightness AND no edges.
 * Real frames, including very dark ones, have edges.
 *
 * ⚠️ This is NOT a quality floor, and the distinction is the one the capture
 * loop already cared about: a dim room must still keep a frame, or the checking
 * state goes back to a black rectangle — which is the very thing being guarded
 * against. Only a frame with no information at all is rejected.
 */
export function frameHasContent(canvas: HTMLCanvasElement): boolean {
    const img = getDownsampledImageData(canvas);
    if (!img) return false;
    return computeBrightness(img) > 1 || computeSharpness(img) > 1;
}

/**
 * Run the look pipeline over a captured frame.
 *
 * Every stage fails soft: a stage that cannot run leaves the image as it found
 * it and reports why. The worst outcome available here is the photograph that
 * shipped before any of this existed, which is the right floor for a step a
 * sign-in depends on.
 *
 * `meter` is the region exposure is judged from — the face box, when a caller
 * knows it. See `meterFromLandmarks`. Absent one, `captureLook` meters the
 * centre of the frame, which AWS's oval makes a safe guess.
 */
export async function processFrame(
    frame: HTMLCanvasElement,
    meter?: MeterRegion,
): Promise<FaceCapture> {
    const q = CAPTURE_OUTPUT.jpegQuality;

    // What the screen gets. Built first because it takes every edit, and the
    // stored version is then assembled from whichever of them apply to it.
    const display = copyOf(frame);

    const tone = CAPTURE_TONE.enabled ? analyseTone(frame, meter) : null;
    if (tone) applyTone(display, tone);

    /*
     * The look BEFORE the portrait blur, and the order is not arbitrary.
     *
     * The beauty half decides what to smooth by how far a pixel differs from
     * its local average, and it finds the face by skin tone. Running it after a
     * background blur would hand it a frame where the room has no detail left,
     * so every background pixel that happens to sit in the skin-tone cluster —
     * wood, cardboard, a beige wall — reads as perfectly smooth skin and gets
     * "corrected" again. Sharp room first, then defocus it.
     *
     * DISPLAY ONLY. See the header of `look.ts` and `CAPTURE_OUTPUT.bakeBeauty`:
     * none of this touches the image the backend is given.
     */
    const look = applyLook(display);

    const portrait = CAPTURE_PORTRAIT.enabled ? await applyPortrait(display) : null;

    /*
     * ── The floor: never worse than the frame we were given ─────────────────
     *
     * Every stage above is written to fail soft, and every stage above is also
     * canvas code — where the characteristic failure is not an exception but a
     * silently wrong picture. An unparsed `fillStyle` keeps its previous value
     * and paints opaque black. A discarded backing store reads as transparent,
     * which encodes to black. A filter the engine does not support is ignored.
     * None of those throw, so none of them reach a `catch`.
     *
     * So the result is checked rather than trusted. If the pipeline turned a
     * real photograph into a blank, every edit is thrown away and the frame as
     * the camera gave it is returned — which is the picture that shipped before
     * any of this existed, and the correct floor for a step a sign-in depends
     * on. A cosmetic improvement is never worth a black photograph on an
     * identity record.
     *
     * The warning is deliberate and specific: this is a BUG in a stage, not a
     * bad capture, and it should be findable in a console rather than inferred
     * from a photo that looks a bit off.
     */
    if (!frameHasContent(display) && frameHasContent(frame)) {
        console.warn(
            '[capture] the look pipeline blanked a good frame — falling back to the raw capture',
        );
        const raw = frame.toDataURL('image/jpeg', q);
        return {
            stored: raw,
            display: raw,
            tone: null,
            look: null,
            portrait: null,
            width: frame.width,
            height: frame.height,
            storedBytes: Math.round((raw.length * 3) / 4),
        };
    }

    let stored: string;
    if (CAPTURE_OUTPUT.bakePortrait && portrait?.applied) {
        stored = display.toDataURL('image/jpeg', q);
    } else if (CAPTURE_OUTPUT.bakeTone && tone) {
        // Tone re-applied to a clean copy rather than reusing `display`, which
        // by now may carry a blur that is explicitly not meant to be submitted.
        const baked = copyOf(frame);
        applyTone(baked, tone);
        stored = baked.toDataURL('image/jpeg', q);
    } else {
        stored = frame.toDataURL('image/jpeg', q);
    }

    return {
        stored,
        display: display.toDataURL('image/jpeg', q),
        tone,
        look,
        portrait,
        width: frame.width,
        height: frame.height,
        storedBytes: Math.round((stored.length * 3) / 4),
    };
}

/** Brightness and sharpness of a finished capture — for the bench's readout. */
export function describeCapture(canvas: HTMLCanvasElement): {
    brightness: number;
    sharpness: number;
} | null {
    const img = getDownsampledImageData(canvas);
    if (!img) return null;
    return { brightness: computeBrightness(img), sharpness: computeSharpness(img) };
}

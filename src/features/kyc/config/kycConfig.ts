/**
 * KYC Verification — Central Configuration
 *
 * Single source of truth for every threshold, timeout, and constant used
 * across the KYC/verification flow. Works on both client and server (API routes).
 *
 * ─── 2 Sections ──────────────────────────────────────────────────────────────
 *   1. idConfig      — ID & Passport capture (quality, card detection, OCR, MRZ/barcode)
 *   2. compareConfig — Face-to-ID comparison (similarity thresholds, timing)
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ID & PASSPORT CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const idConfig = {
    // ── Local image quality gates ─────────────────────────────────────────────
    // Canvas-API checks run on every frame BEFORE an AWS Textract call is made.
    // Raising these reduces wasted AWS calls; lowering them allows dimmer/blurrier
    // environments through (the server will still reject truly bad frames).
    //
    // NOTE: Thresholds are calibrated for real physical IDs (reflected light).
    // Screen-displayed IDs have 3–5× higher edge contrast; using screen-tuned
    // values here caused 'too_blurry' false-rejections on real documents.
    quality: {
        /**
         * Minimum mean luminance [0–255]. Below this → "Too dark".
         *
         * ⚠️ This is the mean of the WHOLE FRAME, not of the card. A document
         * held up in a dim room — dark desk, evening light, the card itself
         * perfectly legible — averages well under the old 45 and was told to
         * "move to a brighter area" while a phone scanner app captured the same
         * scene without complaint. The room being dark is not the same as the
         * ID being unreadable, and this check cannot tell the difference.
         *
         * 25 keeps the genuinely hopeless frames (lens covered, lights off)
         * flagged while letting a legible card in a dim room through.
         *
         * Note this gate is ADVISORY on the ID screen: nothing blocks on it.
         * Auto-capture waits on the scanner's lock-on and stability, so all a
         * wrong value here does is put wrong words on the screen — which is
         * its own bug, since it sends the user off to fix the lighting when
         * the actual problem was edge contrast (see the worker's Canny ladder).
         */
        minBrightness: 25,
        /** Maximum mean luminance [0–255]. Above this → "Too bright". */
        maxBrightness: 240,
        /**
         * Sobel-variance floor. Below this → "Hold steady — frame is blurry".
         * Physical IDs under normal indoor lighting produce sharpness ~30–70.
         * The previous value (90) was calibrated for backlit screen displays
         * and blocked virtually every real printed document.
         */
        minSharpness: 28,
        /** Luma value above which a pixel counts as a "blown-out" glare spot. */
        glarePixelThreshold: 245,
        /** Max fraction [0–1] of blown-out pixels before flagging glare. */
        glareMaxRatio: 0.07,
        /** Mean absolute luma diff above which the camera is considered moving. */
        motionMaxDiff: 15,
    },

    // ── Frame stabilisation ───────────────────────────────────────────────────
    stability: {
        /** How long [ms] the frame must stay stable before an AWS call fires. */
        stabilityMs: 1000,
        /** How often [ms] the frame-validation hook re-checks the video. */
        intervalMs: 150,
    },

    // ── Card detection — directional edge analysis ────────────────────────────
    // ID cards produce axis-aligned Sobel edges (text, borders, barcodes).
    // Human faces produce diagonal/curved edges. These thresholds separate them.
    //
    // NOTE: Values are calibrated for real printed documents under hand-held
    // conditions (lower contrast, minor camera movement, various distances).
    // Screen-displayed IDs have higher contrast and don't need this leniency,
    // but the server-side Rekognition spoofing gate handles that case.
    cardDetection: {
        /** Minimum Sobel magnitude to count a pixel as a "significant edge". */
        edgeMagFloor: 10,
        /**
         * Minimum number of significant edge pixels required inside the scan ROI.
         * Physical IDs at arm's length on a 96-px downsampled image produce ~8–20
         * significant edges. The previous value (30) required screen-level contrast.
         */
        cardMinSignificantEdges: 8,
        /**
         * An edge is axis-aligned when min(|Gx|,|Gy|) / max(|Gx|,|Gy|) < this.
         * 0.45 ≈ within ±24° of horizontal or vertical. Slightly more lenient
         * than the previous 0.38 to accommodate hand-printed text variation.
         */
        axisDiagonalityMax: 0.45,
        /**
         * Required fraction of significant edges that must be axis-aligned.
         * Real physical IDs: ~0.52–0.60. Faces: ~0.44–0.50.
         * Set to 0.50 — safely above the face range, below the card range.
         */
        hvFractionThreshold: 0.5,
        /**
         * Border stripe: fraction of border-band edges pointing in the expected
         * direction. Lowered from 0.42 because physical cards held at any
         * distance may not perfectly fill the ROI, so border bands may contain
         * background that lowers this score.
         */
        borderScoreThreshold: 0.18,
        /** How much more dominant the "correct" axis must be inside a border band. */
        borderAxisRatio: 1.3,
        /** Minimum pixels per border band to consider its score meaningful. */
        minBandPx: 2,
    },

    // ── Card geometry (aspect ratio + fill) ───────────────────────────────────
    // CR80 (standard ID) = 1.586:1; passport open page ≈ 1.42:1.
    cardGeometry: {
        aspectRatioMin: 1.4,
        aspectRatioMax: 1.75,
        /** Detected card bounding box must fill at least this fraction of the ROI. */
        minFillRatio: 0,
        /**
         * How far the detected quad's centre may sit from the frame's centre
         * before it stops counting as "the user is presenting their ID".
         *
         * Measured per axis and normalised to the frame's HALF size, so the
         * number reads as a fraction of the way to the edge: 0 is dead centre,
         * 1 is the centroid sitting on the frame edge. The larger of the two
         * axes is the one tested, so a card that is centred vertically but off
         * to one side is still rejected.
         *
         * This is what stops the scanner locking onto whatever else is on the
         * desk. OpenCV will happily return a clean 4-corner quad for a book, a
         * laptop, or a sheet of paper at the edge of frame; the thing that
         * distinguishes the document the user is actually offering up is that
         * they hold it in the MIDDLE, where the guide is.
         *
         * Raise it to accept sloppier framing, lower it to demand tighter
         * centring. Above ~0.35 it stops meaningfully filtering.
         */
        maxCenterOffset: 0.22,
    },

    // ── Moiré / photo-of-screen detection ────────────────────────────────────
    // Screens produce a periodic pixel grid visible as a mid-frequency DFT peak.
    screenDetection: {
        /** DFT profile length. */
        dftSize: 32,
        /** Lower edge of the mid-frequency band (ignore DC). */
        midBandLow: 4,
        /** Upper edge of the mid-frequency band (ignore Nyquist). */
        midBandHigh: 12,
        /** Geometric-mean energy ratio above which we flag a screen. */
        detectionThreshold: 0.45,
    },

    // ── AWS Textract / field validation ───────────────────────────────────────
    fieldValidation: {
        /** Minimum Textract confidence % to accept a field value. */
        fieldConfidenceThreshold: 80,
        /** Number of critical fields required on the FRONT side. */
        minMandatoryFieldsFront: 3,
        /** Number of critical fields required on the BACK side. */
        minMandatoryFieldsBack: 1,
        /**
         * The three fields that must be present and readable on the front side.
         * Mirrors the "QueriesConfig" discipline used in the API route.
         */
        criticalFields: ['FIRST_NAME', 'DATE_OF_BIRTH', 'DOCUMENT_NUMBER'] as const,
    },

    // ── Face photo on ID ──────────────────────────────────────────────────────
    faceOnId: {
        /** Max |faceCenterX – 0.5| allowed before flagging the ID face as off-center. */
        centeringToleranceCx: 0.18,
        /** Max |faceCenterY – 0.5| allowed before flagging the ID face as off-center. */
        centeringToleranceCy: 0.22,
    },

    // ── MRZ & barcode parsing ─────────────────────────────────────────────────
    mrz: {
        /** Minimum raw OCR text length to consider back-side valid. */
        minRawTextLength: 30,
        /**
         * 2-digit year cutoff for MRZ YY→YYYY conversion.
         * yy > yearCutoff → 19xx; yy ≤ yearCutoff → 20xx.
         */
        yearCutoff: 30,
        /** Max number of Textract detected fields to surface in the response. */
        detectedFieldsLimit: 8,
        /** Top-N longest anonymous lines to include alongside named fields. */
        longestLinesTopN: 4,
        /** Minimum text line length to include in raw-text extraction. */
        minLineLength: 4,
    },

    // ── Server-side Sharp cropping ────────────────────────────────────────────
    // These run on the Next.js API routes (Node.js / Sharp) — not in the browser.
    cropping: {
        /** Padding fraction added around a detected ID document crop. */
        idDocPadding: 0.08,
        /** Extra padding when the detected box looks lopsided. */
        idDocPaddingLopsided: 0.25,
        /** Minimum crop-area / full-image ratio — rejects tiny detections. */
        idDocMinAreaRatio: 0.15,
        /** Area ratio above which a detection is considered lopsided. */
        idDocLopsidedAreaRatio: 0.2,
        /** Maximum dimension as a fraction of the source image. */
        idDocMaxDimensionRatio: 0.9,
        /** Padding fraction added around the face photo on the ID. */
        idFacePadding: 0.18,
        /** JPEG quality for server-side crops sent back to the client. */
        jpegQuality: 90,
        /** JPEG quality for client-side canvas captures (0–1 scale). */
        clientJpegQuality: 0.92,
    },

    // ── Client-side OpenCV scanner (worker) ─────────────────────────────────
    openCV: {
        /** Process 1 frame every N animation frames. */
        processEveryNFrames: 4,
        /** Downscaled width cap for worker contour detection. */
        maxProcessingWidth: 960,
        /** Minimum detected quad area ratio (relative to processed frame). */
        minAreaRatio: 0.07,
        /** Max width for dewarped capture output returned from worker. */
        maxOutputWidth: null,
        /** EMA alpha for corner smoothing (higher = snappier, lower = smoother). */
        smoothingAlpha: 0.4,
        /** Safety margin from frame edges; detections inside this margin are rejected. */
        boundaryMarginPx: 5,
        /**
         * Minimum interior content density [0..1] for the scanner to accept a quad
         * as a REAL ID/passport (rejects blank paper / empty rectangles). The score
         * is lighting-normalized in the worker, so these are stable across
         * brightness. Tune here if a real ID is rejected (lower) or blank paper
         * still passes (raise).
         *   front — has photo + dense text/MRZ, so a higher bar is safe.
         *   back  — can be sparse (a little text / one barcode), so a lower bar.
         */
        minInteriorDensityFront: 0.06,
        minInteriorDensityBack: 0.03,
    },

    // ── Back-side cross-verification (Levenshtein) ────────────────────────────
    backVerifier: {
        /** Minimum national-number length before comparing front/back. */
        nationalNumberMinLength: 8,
        /** Minimum document-number length before comparing front/back. */
        documentNumberMinLength: 6,
        /** Minimum last-name length before comparing front/back. */
        lastNameMinLength: 2,
        /** Maximum Levenshtein distance still considered a match. */
        levenshteinMaxDistance: 1,
    },

    // ── Spoofing / anti-replay detection (DetectLabels) ──────────────────────
    // AWS Rekognition DetectLabels runs BEFORE Textract to reject images that
    // are clearly photos of a screen, printed paper, or other reproductions.
    // Edit `rejectionLabels` and `messages` here — no code changes needed.
    spoofingDetection: {
        /** Set to false to disable the DetectLabels gate entirely (e.g. local dev). */
        enabled: false,
        /**
         * Rekognition confidence % floor for rejection.
         * Labels below this are logged but never trigger a rejection.
         * DetectLabels is called with (minConfidence − 15) so all near-threshold
         * labels still appear in the debug log for tuning.
         */
        minConfidence: 70,
        /** Maximum number of labels to request from DetectLabels. */
        maxLabels: 30,

        /**
         * LAYER 1 — Direct label match.
         * Any label whose exact Rekognition name appears here AND whose confidence
         * is ≥ minConfidence triggers an immediate rejection.
         * Add new device/paper names here as Rekognition's taxonomy evolves.
         */
        rejectionLabels: [
            // // Screens & displays
            // 'Monitor',
            // 'Screen',
            // 'Display',
            // 'LCD',
            // 'LED',
            // 'Television',
            // 'TV',
            // // Computers & devices
            // 'Computer',
            // 'Desktop',
            // 'Laptop',
            // 'PC',
            // 'iMac',
            // 'MacBook',
            // // Mobile & tablets
            // 'Mobile Phone',
            // 'Cell Phone',
            // 'Smartphone',
            // 'iPhone',
            // 'Android Phone',
            // 'Tablet',
            // 'iPad',
            // // Paper / printed reproductions
            // 'Paper',
            // 'Document',
            // 'Poster',
            // 'Flyer',
        ] as const,

        /**
         * LAYER 2 — Ancestor / parent match.
         * Rekognition returns a parent chain for every label, e.g.:
         *   "Smartphone" → ["Mobile Phone", "Electronics", "Technology"]
         * If ANY ancestor appears in this list the image is also rejected.
         * This catches sub-variants of electronic devices that aren't listed
         * by exact name above (e.g. brand-specific phone models, new device types).
         */
        rejectionParentLabels: [
            'Mobile Phone',
            'Computer',
            'Monitor',
            'Screen',
            'Electronics',
            'Tablet',
        ] as const,

        /**
         * User-facing messages per detected label (or ancestor name).
         * Keyed by exact Rekognition label name; `default` is the fallback.
         */
        messages: {
            Monitor: 'Please use your real ID card — a screen was detected.',
            Screen: 'Please use your real ID card — a screen was detected.',
            Display: 'Please use your real ID card — a screen was detected.',
            LCD: 'Please use your real ID card — a screen was detected.',
            LED: 'Please use your real ID card — a screen was detected.',
            Television: 'Please use your real ID card — a screen was detected.',
            TV: 'Please use your real ID card — a screen was detected.',
            Computer: 'Please use your real ID card — a computer screen was detected.',
            Desktop: 'Please use your real ID card — a computer screen was detected.',
            Laptop: 'Please use your real ID card — a laptop screen was detected.',
            iMac: 'Please use your real ID card — a computer screen was detected.',
            MacBook: 'Please use your real ID card — a laptop screen was detected.',
            'Mobile Phone': 'Please use your physical ID card, not a photo on a phone.',
            'Cell Phone': 'Please use your physical ID card, not a photo on a phone.',
            Smartphone: 'Please use your physical ID card, not a photo on a phone.',
            iPhone: 'Please use your physical ID card, not a photo on a phone.',
            Tablet: 'Please use your physical ID card, not a photo on a tablet.',
            iPad: 'Please use your physical ID card, not a photo on a tablet.',
            Electronics: 'Please use your physical ID card, not a photo on a device.',
            Paper: 'Printed or photocopied IDs are not accepted. Please use the original document.',
            Document:
                'Printed or photocopied IDs are not accepted. Please use the original document.',
            default: 'Real ID required — please present your original identity document.',
        } as Record<string, string>,
    },

    // ── Polling & UI timing (IDCaptureScreen) ────────────────────────────────
    timing: {
        /** How often [ms] the polling loop checks for a new valid frame. */
        pollIntervalMs: 500,
        /** Pause [ms] after "Document detected" before firing the AWS call. */
        captureDelayMs: 600,
        /** Debounce [ms] for failure-reason messages (fast — user needs to act). */
        statusDebounceFastMs: 1200,
        /** Debounce [ms] for pass/transition messages (slower — avoids flicker). */
        statusDebounceMs: 1200,
        /** How long [ms] without a face on the ID before showing the flip hint. */
        flipHintDelayMs: 3000,
        /** How often [ms] to run the MediaPipe face check on the rear camera. */
        faceCheckIntervalMs: 600,
        /** Pause [ms] on success before auto-switching to the back side. */
        successPauseMs: 1000,
        /** Pause [ms] before starting back-side polling after the side switch. */
        backSwitchDelayMs: 1500,
        /** Pause [ms] after final capture before navigating to ID Summary. */
        postCaptureNavMs: 800,
        /** How long [ms] to display a server rejection reason before resetting. */
        rejectionDisplayMs: 1200,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — COMPARE / FACE-MATCH CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const compareConfig = {
    // ── AWS Rekognition CompareFaces similarity thresholds ────────────────────
    // ⚠️ SINGLE SOURCE OF TRUTH — change `passThreshold` here and the entire
    // pipeline (server route + client UI) updates. Default = 80%.
    similarity: {
        /**
         * Minimum similarity [0–100] for an automatic PASS.
         * Scores at or above this go straight to video-pre-call.
         */
        passThreshold: 0,
        /**
         * Minimum similarity [0–100] for a soft PASS (manual review queued).
         * Scores between reviewThreshold and passThreshold trigger the review banner.
         */
        reviewThreshold: 75,
        /**
         * The similarity floor passed to the AWS CompareFaces API as the
         * `SimilarityThreshold` parameter. Faces below this are never returned.
         */
        awsFilterFloor: 75,
    },

    // ── Timing ───────────────────────────────────────────────────────────────
    timing: {
        /** Pause [ms] after a successful match before navigating onward. */
        successNavDelayMs: 2000,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — FACE LIGHTING
// ─────────────────────────────────────────────────────────────────────────────
/**
 * What counts as enough light to attempt a face check.
 *
 * ⚠️ SHARED BY BOTH FACE PATHS, deliberately. `useFaceGate` (the single-frame
 * capture) and `useLightCheck` (the pre-flight gate in front of AWS Face
 * Liveness) read the same two numbers. They used to be private constants in
 * `useFaceGate`; two gates in the same sign-in disagreeing about what "dark"
 * means is a bug nobody would ever see in review — one screen waves a frame
 * through and the next refuses it.
 *
 * ⚠️ NOT the same as `idConfig.quality`, and must not be merged with it. That
 * gate reads the whole frame with a card in it and sits at 25, low enough to
 * let a legible ID through in a dim room. A FACE is not a card: the subject is
 * the middle of the frame and the verifier is judging skin, so the floor is far
 * higher. Merging the two would either blind this gate or start telling people
 * photographing an ID on a dark desk to find a lamp.
 */
export const faceLightConfig = {
    /**
     * Minimum mean luminance [0–255] of the CENTRE box. Below this the face is
     * too dark for the verifier, whatever the rest of the room is doing.
     */
    minBrightness: 55,
    /** Maximum mean luminance [0–255] of the centre box — blown-out skin. */
    maxBrightness: 215,
    /**
     * Sobel-variance floor, measured on the CENTRE box like the light is.
     *
     * ⚠️ 8, matching `useFaceGate`'s own `MIN_SHARPNESS`, and NOT the ID gate's
     * 28. A face has far less edge contrast than printed text on a card — skin
     * is mostly smooth — so the card's floor would call every real face blurry.
     *
     * Deliberately a LOW bar. This is meant to catch a camera that has not
     * focused, a lens someone has smeared, or a phone being moved — not to
     * grade photographs. A soft frame that a person can still be recognised in
     * must pass, because the alternative is refusing somebody for a webcam they
     * cannot do anything about.
     */
    minSharpness: 8,
    /**
     * Share of each axis sampled for the "face" reading, so 0.5 is the middle
     * quarter by area. Roughly the oval the person is asked to fill.
     */
    centreFraction: 0.5,
    /**
     * Frame-mean ÷ centre-mean above which a dark centre is read as BACKLIGHT
     * rather than a dark room — a window or lamp behind the person.
     *
     * Worth separating because the instruction is the opposite of the obvious
     * one: they are standing in plenty of light and "find brighter light" is
     * useless advice. 1.6 is comfortably clear of an evenly lit room, where the
     * two means land within a few percent of each other.
     */
    backlitRatio: 1.6,
    /**
     * How long the light must be good CONTINUOUSLY before the check starts.
     *
     * Not zero: a camera's auto-exposure takes a moment to settle after the
     * stream opens, and the first frames of a perfectly well-lit room can read
     * almost black. Starting on the first good sample would let that settling
     * decide when a billed session opens.
     */
    stableMs: 700,
    /** How often the probe samples a frame. */
    sampleMs: 150,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE RE-EXPORTS
// Import the whole bundle when you need everything:
//   import { kycConfig } from '@/features/kyc/config/kycConfig';
//   kycConfig.id.cardGeometry.minFillRatio
// ─────────────────────────────────────────────────────────────────────────────
export const kycConfig = {
    id: idConfig,
    compare: compareConfig,
    faceLight: faceLightConfig,
} as const;

export default kycConfig;

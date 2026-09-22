/**
 * Every knob that decides how the captured face LOOKS, in one table.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The photograph is produced in one place (`LivenessCamera`), judged in
 * another (`/design/capture-lab`) and displayed in three more (the verdict
 * frame, the face-match screen, the intro avatar). The first time this was
 * attempted the numbers lived at each of those sites, so the bench was tuning
 * a different pipeline from the one that shipped, and "it looked fine when I
 * checked it" was true and useless at the same time.
 *
 * The bench imports these. The flow imports these. Tuning one tunes both.
 *
 * ── The rule this whole file obeys ──────────────────────────────────────────
 * NOTHING here invents detail that the sensor did not record.
 *
 * That is the lesson of the reverted attempt (2026-09-20, `git log`): every
 * edit that guessed at missing pixels — filling the hole where the subject was
 * cut out, smearing the room outward, smoothing skin — looked right in the room
 * it was tuned in and wrong in the next one. What is left here is the set of
 * operations a phone's own camera app performs on every photograph it takes:
 * expose it, neutralise the colour cast, and separate the subject from the
 * room. Those are corrections, and a correction derived from the image cannot
 * disagree with the image.
 */

/**
 * ── 1. Resolution ───────────────────────────────────────────────────────────
 *
 * THE reason the photograph looks soft, and the single biggest win available.
 *
 * AWS hardcodes what it asks the camera for — `STATIC_VIDEO_CONSTRAINTS` in
 * `@aws-amplify/ui-react-liveness/.../utils/helpers.mjs`:
 *
 *     width:  { min: 320, ideal: 640 }
 *     height: { min: 240, ideal: 480 }
 *
 * and `FaceLivenessDetectorCore` exposes no prop that overrides it. So the
 * check runs on VGA, we keep a 420x480 crop of that, and it is painted into a
 * 350x400 frame — which on a phone at devicePixelRatio 3 is 1050x1200 real
 * pixels. A two-and-a-half times upscale of a webcam frame. No amount of
 * colour work rescues that; there is simply not enough picture.
 *
 * `installCaptureQuality` raises the request before it reaches the browser.
 * AWS's own floor is 320x240, so a larger stream satisfies every constraint it
 * set, and everything downstream — the oval's geometry, the face-fit test, the
 * anchor's size — is read live from the stream it actually got, so all of it
 * stays consistent. See the note in `cameraShim.ts` about why there is exactly
 * one patcher over that global.
 *
 * ⚠️ 1280x960 and not 1920x1440, for two reasons that are not about looks:
 *
 *   - AWS streams this video to Rekognition over a websocket for the duration
 *     of the check. Four times the pixels is a real cost on the connections
 *     this runs on, and a check that times out is worse than a soft photo.
 *   - `min: 320/240` means a camera that cannot do 960 still returns something.
 *     `ideal` never rejects — that is why it is `ideal` and not `exact`.
 *
 * 4:3, deliberately: the same shape AWS asks for, so nothing about the field
 * of view changes. This buys pixels, not a wider picture. The framing is a
 * separate problem — see §2.
 */
export const CAPTURE_RESOLUTION = {
    /** Raise AWS's camera request. Turn off to reproduce the shipped VGA look. */
    enabled: true,
    width: 1280,
    height: 960,
} as const;

/**
 * ── 2. Framing ──────────────────────────────────────────────────────────────
 *
 * "It is a face and nothing else."
 *
 * Two separate causes, and only one of them is ours:
 *
 *   THEIRS — AWS issues the oval in the session (`Challenge.OvalParameters`)
 *   at about 97% of the stream's height, and the face-fit test measures against
 *   it. The person genuinely has to fill the frame; `CreateFaceLivenessSession`
 *   takes no parameter for it. The zoom experiment tried to route around this
 *   and made it worse, because a lens zoom crops tighter still (`git log`,
 *   5d7f21c).
 *
 *   OURS — we then threw away a third of what the sensor did record. A 4:3
 *   stream centre-cropped to the frame's 0.875 discards 34% of the width,
 *   and that width is the only head-room and shoulder in the picture.
 *
 * So: keep the whole sensor frame in the file, and let the 350x400 frame crop
 * it at DISPLAY with `object-fit: cover`.
 *
 * This is not a change to what the user sees during the check — the preview is
 * already a cover-crop of the same stream, so the on-screen result is
 * identical to the pixel. What changes is that the stored photograph is no
 * longer pre-trimmed to the tightest crop any screen will ever want, so the
 * match screen, the avatar and anything later can frame it for themselves, and
 * CompareFaces is handed more of the face rather than less.
 *
 * ⚠️ The comment this replaces argued the capture must be pre-cropped so it
 * "cannot disagree with the preview". Storing wider and cropping at display
 * satisfies that in full: same crop, same picture, more pixels behind it.
 */
export const CAPTURE_FRAMING = {
    /** Keep the full sensor frame in the file; crop only when displaying. */
    keepFullFrame: true,
    /** The frame the picture is shown in — what `object-fit: cover` trims to. */
    displayAspect: 350 / 400,
} as const;

/**
 * ── 3. Tone ─────────────────────────────────────────────────────────────────
 *
 * The difference between this and the reverted attempt, stated plainly,
 * because it is the only reason to believe this one survives.
 *
 * That attempt exported fixed constants — a brightness, a saturation, a
 * smoothing radius — and applied them to every frame. A fixed +12% brightness
 * is correct for exactly one exposure, and a webcam in an office at noon and a
 * phone in a hallway at night are not that one exposure. So it looked tuned in
 * the room it was tuned in, and over- or under-cooked everywhere else. That is
 * not a bug in the numbers; no number exists that is right for both.
 *
 * Everything below is instead MEASURED off the frame and applied as a
 * correction toward a target (`analyseTone` / `applyTone` in
 * `services/captureLook.ts`):
 *
 *   black/white point   the actual darkest and brightest percentiles
 *   exposure            whatever gain lands the FACE at `targetFaceLuma`
 *   white balance       the grey-world channel gains this frame needs
 *
 * A dark frame gets lifted and a bright one does not, because the amount is
 * read from the frame. This is, to within a rounding error, what the phone's
 * own camera app does between the sensor and the JPEG — which is precisely the
 * comparison the complaint was making.
 *
 * ── Every number here is a LIMIT, not an amount ─────────────────────────────
 * The amounts come from the image. These cap how far a correction may go, so a
 * pathological frame (a face against a window, a pitch-dark room) is improved
 * rather than transformed into something that is no longer a photograph of that
 * person in that place.
 */
export const CAPTURE_TONE = {
    enabled: true,

    /**
     * Where the face's mean luminance should land, 0..1.
     *
     * 0.54 rather than a middle 0.5: faces read as correctly exposed slightly
     * above mid-grey, which is why every camera's face-detection metering
     * targets a little high. Below about 0.45 skin goes muddy on an OLED phone
     * at half brightness, which is the actual viewing condition here.
     */
    targetFaceLuma: 0.54,

    /**
     * How far the exposure correction may go, as a multiplier.
     *
     * Bounded because the alternative is amplifying sensor noise until a dim
     * room becomes a bright grainy one. Past roughly 1.8x there is no signal
     * left to lift — the honest answer to a genuinely dark frame is a dark
     * photograph, not a noisy bright one.
     */
    exposureMin: 0.72,
    exposureMax: 1.85,

    /**
     * Percentiles taken as the black and white points.
     *
     * Not 0 and 100: a single blown pixel or one dead-black corner would set
     * the whole stretch, and both are common — a window behind the subject,
     * the unlit edge of a hoodie. Half a percent at each end ignores the
     * outliers and reads the picture.
     */
    blackPercentile: 0.005,
    whitePercentile: 0.995,

    /**
     * Cap on the levels stretch, in 0..255 input units.
     *
     * A frame that genuinely occupies 40..210 is stretched to full range and
     * looks like a photograph. A frame that occupies 118..134 is fog, and
     * stretching THAT to full range produces posterised bands, not contrast.
     * This is the line between the two.
     */
    maxBlackLift: 42,
    maxWhitePull: 42,

    /**
     * Contrast S-curve strength, 0 = off.
     *
     * A gentle toe and shoulder — the film-like response every phone applies
     * after levels. Kept low: this is the one control here that is a look
     * rather than a correction, and a strong S-curve on a face crushes the
     * shadow side of the nose.
     */
    sCurve: 0.16,

    /**
     * How much of the grey-world white-balance correction to apply, 0..1.
     *
     * NOT 1. Grey-world assumes the average of the scene is neutral, which is
     * false in the direction that matters here: a face fills the frame, skin is
     * warm, so a full correction reads the subject as a colour cast and cools
     * the person to a corpse. Two-fifths removes the tungsten and fluorescent
     * casts a room actually has without arguing with the fact that there is a
     * person in the picture.
     */
    whiteBalance: 0.4,

    /** Cap on any single channel gain, so one coloured lamp cannot tint everything. */
    whiteBalanceMaxGain: 1.22,

    /**
     * Saturation multiplier applied after levels.
     *
     * Levels stretching desaturates slightly — the channels are pulled apart
     * around a common midpoint — so this is mostly putting back what the
     * correction took, not adding colour.
     */
    saturation: 1.06,

    /**
     * Warmth, in 0..255 units added to red and removed from blue at midtones.
     *
     * Small and deliberate. Every consumer camera warms skin a little because
     * a neutrally-correct face reads as slightly ill on a screen. Three units
     * is under a percent and is felt rather than seen.
     */
    warmth: 3,
} as const;

/**
 * ── 3b. Beauty ──────────────────────────────────────────────────────────────
 *
 * Smoother skin. DISPLAY-ONLY, permanently — see `CAPTURE_OUTPUT.bakeBeauty`.
 *
 * ── Why this one is allowed to exist despite the rule above ─────────────────
 * The rest of this file is corrections; this is unambiguously a look, and it is
 * the one edit that changes a person's face rather than how it was lit. The
 * reason it is safe here is the two-image split: the photograph handed to the
 * backend, written to the identity record and given to CompareFaces is the
 * untouched one, and this never reaches it. The person sees a flattering
 * picture and the system receives the truthful one. Bake this and that argument
 * collapses, taking the match score with it — the comparison reads exactly the
 * mid-frequency detail this attenuates.
 *
 * ── Why it is not a blur ────────────────────────────────────────────────────
 * Frequency separation with edge preservation: only LOW-CONTRAST detail is
 * attenuated — pores, blotches, noise — while lashes, nostrils, lip edges and
 * the jawline are left alone and then slightly sharpened. `services/beauty.ts`
 * explains the mechanism. A plain blur is what the reverted attempt did, and
 * "the face looked blurred" is what it was reverted for.
 *
 * Tune it on `/design/capture-lab`, which has a live strength slider.
 */
export const CAPTURE_BEAUTY = {
    enabled: true,

    /**
     * How much of the low-contrast detail to remove, 0..1.
     *
     * 0.55 is deliberately short of the maximum. Full removal gives the
     * airbrushed look that reads as a filter within about half a second; a
     * little residual texture is most of what separates "well lit" from
     * "retouched", and the goal here is the first one.
     */
    strength: 0.55,

    /**
     * The line between texture and a feature, in 0..255 channel units.
     *
     * THE number that decides whether this looks like good light or like a
     * filter. A difference from the local average smaller than this is treated
     * as skin texture and smoothed; anything larger is treated as part of the
     * face and kept.
     *
     * Too low and pores survive while the effect does nothing. Too high and
     * eyelashes and the edge of the lips fall below the line and dissolve,
     * which is the wax-model failure. 14 sits comfortably above sensor noise
     * and skin unevenness, and well below any real facial edge.
     */
    detailThreshold: 14,

    /**
     * Smoothing radius as a fraction of the FACE's width, not the image's.
     *
     * ⚠️ The distinction is the documented reason the first attempt failed:
     * "the smoothing radius was a fraction of image width and the face's share
     * of the frame had changed underneath it". The face is measured from the
     * skin mask itself — see `applyBeauty` — so this is proportionally the same
     * whether the person fills the frame or not.
     */
    radiusPerFaceWidth: 0.022,
    radiusMin: 2,
    radiusMax: 18,

    /**
     * How much of the FEATURE detail to add back, 0..1.
     *
     * Applied only where the smoothing did nothing — lashes, nostrils, the lip
     * line — so it sharpens the face without undoing the skin. This is what
     * stops the result reading as soft-focus: the eye judges sharpness from
     * edges, and those edges end up slightly crisper than they started.
     */
    clarity: 0.25,

    /**
     * Luminance lift on skin midtones, 0..1.
     *
     * The "good light" half of the effect. Small on purpose — past a few
     * percent it stops looking like light and starts looking like someone
     * dragged the brightness slider.
     */
    glow: 0.06,

    /**
     * Minimum share of the frame that must read as skin before this runs.
     *
     * Below it there is no face in the picture, and a pass that smooths
     * whatever happened to land in the skin-tone cluster is worse than no pass.
     */
    minSkinShare: 0.04,
} as const;

/**
 * ── 3c. Portrait Lighting ───────────────────────────────────────────────────
 *
 * The iPhone effect, and specifically **Studio Light** — a large soft frontal
 * source that brightens the face and, above all, LIFTS THE SHADOWED SIDE so
 * harsh modelling from a ceiling light or a window softens out.
 *
 * DISPLAY-ONLY, permanently, for the same reason as the beauty pass: this
 * changes how a face appears to have been lit, and the photograph the backend
 * and CompareFaces receive must be the one the sensor recorded.
 *
 * ⚠️ It does NOT use the segmentation mask, and `services/lighting.ts` explains
 * why at length. Short version: relighting inside a mask turns every
 * segmentation error into a visible seam around the hair, which is exactly what
 * the reverted attempt did ("a studio sweep put a seam where the mask was least
 * certain"). The light here is weighted by skin membership and a broad radial
 * falloff — continuous functions with no boundary to be wrong about.
 *
 * Stage Light is deliberately not offered: it needs the background dropped to
 * black, which requires trusting that mask absolutely.
 */
export const CAPTURE_LIGHTING = {
    enabled: true,

    /** `natural` is Apple's "no effect". `studio` is the one worth having. */
    style: 'studio' as 'natural' | 'studio' | 'contour',

    /**
     * Overall dial on the whole effect, 0..1. Tune on /design/capture-lab.
     *
     * Lowered from 0.75 on 2026-09-22 — reported as too strong once it was
     * running on the live camera as well as the capture. Worth recording why
     * that happened rather than just moving the number: a still is glanced at,
     * but a live preview is stared into for the length of a check, and an
     * effect calibrated against the first reads as heavy-handed in the second.
     * Sustained looking is the harsher test, so this is now set against it.
     */
    strength: 0.45,

    /**
     * How much the shadows are filled, 0..1.
     *
     * THE number that makes this read as a soft source rather than as the
     * brightness slider. Applied as `(1 - v)^1.6`, so it is strongest at black
     * and zero at white — which is both what a big source does and the reason
     * it can never blow a highlight however high this goes.
     *
     * 0.24 rather than 0.30: the fill is the part that most obviously reads as
     * an effect when it is overdone, because a face with no shadow side at all
     * looks like it was cut out and pasted onto the frame.
     */
    shadowLift: 0.24,

    /**
     * How far toward an even tone the face is pulled, 0..1.
     *
     * A large source reduces the RANGE across a face, not only its brightness.
     * Small deliberately: taken far, this is what makes a face look pasted on —
     * which is also why it came down with the rest.
     */
    flatten: 0.09,
    /** Where that pull aims, 0..1 — a touch above mid, where lit skin sits. */
    flattenTarget: 0.62,

    /** A little overall gain on skin midtones, so the lit side lifts too. */
    /** A little overall gain on skin midtones, so the lit side lifts too.
     *  Trimmed with the rest on 2026-09-22 — see `strength`. */
    skinGain: 0.07,

    /**
     * Reach of the softbox, in FACE WIDTHS.
     *
     * Measured against the face rather than the frame, like every other radius
     * here — see the note on `CAPTURE_PORTRAIT.blurRadiusPerFaceWidth` for the
     * failure that rule exists to prevent. 1.9 reaches the shoulders and dies
     * well before the edges of the frame, which is what keeps it reading as a
     * light rather than an exposure change.
     */
    keyRadiusPerFaceWidth: 1.9,

    /** Contour only: how much shadows deepen and highlights strengthen. */
    contourDepth: 0.22,

    /** Below this share of skin there is no face to light. */
    minSkinShare: 0.04,
} as const;

/**
 * ── 3d. The live preview ────────────────────────────────────────────────────
 *
 * Running the look on the LIVE camera, not only on the capture.
 *
 * ⚠️ THIS CANNOT AFFECT THE LIVENESS CHECK, and the reason is structural rather
 * than careful: AWS streams the MediaStream track to Rekognition and runs its
 * face-fit test against the stream's own geometry. Neither reads the pixels we
 * paint over the video. The check is performed on the unmodified camera; the
 * retouched frame exists only on screen. Any change that makes the displayed
 * pixels feed back into the check is a security regression.
 *
 * ── The real constraint is CPU, and it is not theoretical ───────────────────
 * This runs while the device is encoding and uploading video for the check, and
 * AWS refuses any camera it measures below 15fps (`CAMERA_FRAMERATE_ERROR`,
 * which this codebase has already been bitten by once). A prettier preview that
 * costs a failed sign-in is a bad trade.
 *
 * So `useLivePreview` governs itself against these numbers: it processes below
 * display resolution, measures its own cost, and steps down — resolution, then
 * frame rate, then off entirely — rather than competing with the check. Giving
 * up is a normal outcome. The CAPTURE is processed at full quality regardless,
 * so the photograph is unaffected by anything decided here.
 */
export const CAPTURE_LIVE = {
    /** The master switch. Off means the plain camera, and a full-quality still. */
    enabled: true,

    /**
     * Processing resolution, as a fraction of the displayed canvas.
     *
     * 0.55 rather than 1.0 because both edits are LOW-FREQUENCY by nature — a
     * shadow lift and a skin smooth both survive being computed at half size
     * and scaled up, where a sharpen would not. This is the single biggest
     * lever on cost: halving the scale quarters the pixel count.
     */
    startScale: 0.55,
    /** Below this the preview is too soft to be worth showing; drop fps instead. */
    minScale: 0.3,

    /**
     * Cap on the display canvas's resolution.
     *
     * The frame is 350x400 XD px, which on a phone at devicePixelRatio 3 is
     * about 1050x1200 real pixels — but a preview does not need to be
     * pixel-exact, and every pixel here is one the governor has to pay for.
     */
    maxDisplayWidth: 720,

    /**
     * How long one processed frame may take before the governor reacts.
     *
     * 11ms is a third of a 30fps budget. Deliberately conservative: the
     * remaining two thirds are not spare, they belong to video encoding, the
     * websocket, AWS's own face detection and the compositor.
     */
    frameBudgetMs: 11,
    /** Consecutive overruns tolerated before stepping down. */
    overrunsBeforeDrop: 8,

    /** Never process faster than this, whatever the device can manage. */
    maxFps: 30,
    /** The slowest worth showing; below it the preview judders visibly. */
    minFps: 15,

    /**
     * How often the face is re-measured, in ms.
     *
     * The measurement scans the whole buffer a second time and a face does not
     * move appreciably in a tenth of a second, so it runs on its own slower
     * clock and the answer is reused. This was about a third of the per-frame
     * cost before it was separated.
     */
    faceRefreshMs: 120,

    /**
     * How often the portrait segmentation is re-run, in ms.
     *
     * Far slower than everything else here, because segmentation is a whole
     * neural network per call against a per-pixel pass that costs single-digit
     * milliseconds — it is the most expensive thing this loop can do by an
     * order of magnitude. A head does not move appreciably in 150ms, so the
     * previous mask still describes the current frame.
     *
     * ⚠️ The COMPOSITE still runs every frame. That is what keeps the sharp
     * subject aligned with the picture while the mask underneath it is stale;
     * skipping it too would make the whole image lurch at 6fps.
     */
    maskRefreshMs: 150,
} as const;

/**
 * ── 4. Portrait ─────────────────────────────────────────────────────────────
 *
 * The iPhone-camera look: the person sharp, the room behind them soft.
 *
 * ⚠️ READ THIS BEFORE CHANGING ANY NUMBER HERE. This pipeline was written once
 * before and reverted (`git log` 7cecf4b, 5d7f21c). Four things went wrong, and
 * `services/portrait.ts` is built around not repeating them:
 *
 *   1. The subject was CUT OUT before the blur, leaving a person-shaped hole
 *      that had to be filled — and every way of filling it invented pixels. The
 *      room shrunk inward drew a line around the head; the room smeared outward
 *      drew streaks off the hair.
 *      → Now the blur happens IN PLACE on the whole frame. There is no hole,
 *        so there is nothing to invent.
 *
 *   2. Blurring in place was tried and "left the face looking blurred", because
 *      the sharp subject was composited back with a hard mask edge, so every
 *      place the mask was wrong showed blur on skin.
 *      → Now the mask is feathered and the sharp subject is composited over the
 *        blur, so a mask error costs a soft millimetre at the silhouette rather
 *        than a blurred cheek.
 *
 *   3. The blur radius was a fraction of IMAGE WIDTH, and the face's share of
 *      the frame changed underneath it — so the same setting was a whisper on
 *      one capture and a smear on the next.
 *      → `blurRadiusPerFaceWidth` below. The radius is a fraction of the
 *        SUBJECT's width, so it is proportionally identical whether the face
 *        fills the frame or sits in a corner. This is the fix that makes the
 *        number mean something.
 *
 *   4. A background REPLACEMENT (flat white, a studio sweep) was tried and read
 *      as a cut-out, with a seam exactly where segmentation is least certain.
 *      → Not attempted. The room stays; it is only defocused. A blur that is
 *        slightly wrong at the edge looks like a photograph; a matte that is
 *        slightly wrong at the edge looks like a mistake.
 */
export const CAPTURE_PORTRAIT = {
    /**
     * ON, by request (2026-09-22), for the capture AND the live preview.
     *
     * It shipped off, and that was a position rather than caution: this is the
     * one operation here that is a LOOK rather than a correction, it is the one
     * that was reverted in September, and it costs a 250 KB model download. The
     * owner asked for it twice, which settles it — but the reasons it was
     * guarded are still the reasons to watch it, so they stay written down:
     *
     *   - it is the most expensive thing in the pipeline by an order of
     *     magnitude, and on the LIVE path it is the first thing to push a
     *     weaker device into `useLivePreview`'s governor. `/design/capture-lab`
     *     has a "Live blur" toggle and prints the frame cost, which is how you
     *     find out whether it is what made a preview stutter.
     *   - it fails soft everywhere. No model, no WebGL, or a mask claiming less
     *     than 8% or more than 95% of the frame, and the original frame is
     *     returned untouched.
     *
     * Setting this back to `false` turns it off for both paths at once, and
     * nothing else has to change.
     */
    enabled: true,

    /**
     * Blur radius as a fraction of the subject's bounding-box WIDTH.
     *
     * See failure 3 above — this being relative to the subject rather than the
     * frame is the whole point. 0.09 of a face-width is roughly what a phone's
     * portrait mode gives at its default aperture: the room is plainly soft,
     * individual objects are still identifiable, and nobody reads it as a
     * mistake.
     */
    blurRadiusPerFaceWidth: 0.09,

    /** Hard limits in pixels, so a tiny or enormous capture stays sane. */
    blurRadiusMin: 4,
    blurRadiusMax: 48,

    /**
     * How far the mask edge is feathered, as a fraction of subject width.
     *
     * The single most important number for whether this looks like a
     * photograph. A hard edge puts a visible cut around the hair — the exact
     * artefact that sank the first attempt. Feathering trades that for a soft
     * transition, which is what an out-of-focus falloff actually looks like.
     */
    featherPerFaceWidth: 0.02,
    featherMin: 2,

    /**
     * How much darker the background is than the subject, 0..1.
     *
     * Blur alone does not read as portrait mode; depth does, and a few percent
     * of falloff behind the subject is most of what sells it. Small enough
     * that a white wall is still white.
     */
    backgroundDim: 0.1,

    /**
     * Corner vignette strength, 0..1. Applied to the whole frame.
     *
     * The other half of "looks like a camera app". Every phone adds one.
     */
    vignette: 0.16,

    /**
     * Sanity bounds on the mask's share of the frame.
     *
     * Outside these the segmentation is not describing a person in a room —
     * it has found the whole frame, or nothing — and the original is returned
     * untouched. A disappointing background is a cosmetic problem; a mangled
     * capture is a failed sign-in.
     */
    minSubjectShare: 0.08,
    maxSubjectShare: 0.95,
} as const;

/**
 * ── 5. What is written into the file ────────────────────────────────────────
 *
 * The capture is not only shown to the user. It is the image CompareFaces is
 * given at `face-match`, and it is stored on the identity record.
 *
 * So each stage declares whether it is BAKED (written into the JPEG) or
 * DISPLAY-ONLY (applied when painting, never stored).
 */
export const CAPTURE_OUTPUT = {
    /**
     * Tone, baked.
     *
     * The one place this file departs from "never touch the submitted image",
     * and the reasoning is specific rather than aesthetic: a correctly exposed
     * face is a BETTER input to CompareFaces than an underexposed one, because
     * the comparison reads detail out of the midtones and an underexposed frame
     * has crushed them. This moves no feature and reshapes nothing — it is the
     * same correction the phone's own camera would have applied before the
     * image ever existed as a file.
     *
     * ⚠️ If a match score ever regresses after this ships, THIS is the first
     * switch to flip. Turning it off leaves the sensor's own pixels in the file
     * and the corrected version on screen, which is the conservative position
     * and costs nothing but the argument above.
     */
    bakeTone: true,

    /**
     * Beauty, NEVER baked. Not a preference, and not a default to revisit.
     *
     * This is the switch the entire justification for having a beauty filter in
     * a KYC flow rests on. The pass attenuates mid-frequency detail on skin —
     * which is precisely the band CompareFaces reads — so baking it would lower
     * the match score AND alter a photograph whose only purpose is to establish
     * who somebody is. Both at once.
     *
     * Because it is false, the whole feature is free: the person sees a
     * flattering picture, the backend receives the frame the sensor recorded,
     * and nothing downstream can tell the difference. Set it true and there is
     * no version of this worth shipping.
     */
    bakeBeauty: false,

    /**
     * Portrait, NOT baked, and this one is not a preference.
     *
     * Defocusing the room changes pixels that are not the person, which is
     * harmless — but it also softens the boundary between them, and that
     * boundary includes hair, jawline and ears. CompareFaces should be given
     * the frame as it was recorded. The look belongs on the screen.
     */
    bakePortrait: false,

    /**
     * JPEG quality.
     *
     * 0.92 stays. Artefacts land hardest on the mid-frequency detail — eye
     * corners, the edge of the nose — that CompareFaces reads, and the
     * difference against 0.85 is a few tens of kilobytes on an image posted
     * once.
     */
    jpegQuality: 0.92,
} as const;

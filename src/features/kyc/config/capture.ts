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
    /**
     * OFF, by request (2026-09-22). The live camera shows the plain sensor
     * image while a face is being detected — no skin smoothing, no tone or
     * lighting correction, no background blur.
     *
     * ⚠️ THIS DOES NOT TOUCH THE PHOTOGRAPH. `processFrame` applies the full
     * look to the capture regardless of this flag, and every screen that shows
     * that capture afterwards — the intro greeting, the comparison — keeps it
     * via `useFacePhoto`. Off here means the preview is honest about what the
     * camera sees; the picture the person is given is still the flattering one.
     *
     * What it buys: the single largest CPU cost on a screen that is also
     * encoding and uploading video for the liveness check. AWS errors any
     * camera it measures below 15fps (`CAMERA_FRAMERATE_ERROR`, already hit
     * once here), and this loop was the thing competing with it.
     *
     * Everything below still describes the governor, and `/design/capture-lab`
     * still drives it directly, so turning it back on is this one line.
     */
    enabled: false,

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
     * ON — for the CAPTURE and everything that displays it, and for nothing
     * else. By request (2026-09-22).
     *
     * ⚠️ "CAPTURE ONLY" IS ENFORCED AT THE CALL SITES, not here. This flag is
     * read in three places:
     *
     *   processFrame          the photograph. Yes.
     *   useFacePhoto          every later display of that photograph, so the
     *                         intro greeting and the comparison screen match
     *                         the capture. Yes.
     *   useLivePreview        the live camera. NO — both call sites pass
     *                         `portrait: false` outright rather than this flag,
     *                         so the preview stays blur-free even if the live
     *                         look is switched back on.
     *
     * That last line is the whole point of the split. The preview and the
     * photograph now deliberately DISAGREE about whether the room is soft,
     * where they used to be kept in step by this one flag — so the coupling
     * was moved into the call sites, where the difference is visible.
     *
     * The reasons it was guarded originally are unchanged and still worth
     * knowing:
     *
     *   - it is the only operation here that is a LOOK rather than a
     *     CORRECTION. Exposure and skin present a face the sensor recorded;
     *     defocusing the room invents a photograph that was not taken.
     *   - it is the most expensive thing in the pipeline by an order of
     *     magnitude — a neural network per call — and it costs a 250 KB model
     *     download. Off the live path that is paid once, on a still, with
     *     nothing else competing for the CPU.
     *   - it fails soft everywhere. No model, no WebGL, or a mask claiming
     *     less than 8% or more than 95% of the frame, and the original frame
     *     comes back untouched.
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
    blurRadiusPerFaceWidth: 0.02,

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
    backgroundDim: 0,

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

/**
 * ── 9. The checking glass ───────────────────────────────────────────────────
 *
 * The pane laid over the frozen face while the servers decide — the state
 * `LivenessVerdict` renders between the shutter and the verdict.
 *
 * It lives here rather than in the stylesheet for the same reason everything
 * else in this file does: it is a LOOK, it needs tuning against real faces in
 * real rooms, and a number buried in `globals.css` is a number nobody finds.
 * The component writes these onto the element as CSS custom properties and the
 * stylesheet reads them, so this table is the only place to change any of it.
 *
 * ⚠️ Cosmetic, entirely. Nothing here touches the photograph, the comparison,
 * or what is submitted — the glass is painted OVER an image that is never
 * modified. Turning every value to zero leaves a sharp, untouched still with a
 * mark on it, which is a fine thing to see and proves nothing was hidden.
 *
 * ── Tuning it ───────────────────────────────────────────────────────────────
 * `/design/liveness-lab` → "Hold checking" pins the state up indefinitely, so
 * this can be tuned by editing a number and reloading, without spending an AWS
 * check per look.
 */
export const CAPTURE_CHECKING_GLASS = {
    /**
     * THE one to reach for. How far the picture behind the pane is BENT, in
     * pixels, at the rim.
     *
     * This is the effect. A blur averages a picture; glass MOVES it, because
     * light changes direction crossing a boundary — and the displacement map
     * shapes that movement into a lens (nothing through the middle, hardest at
     * the edge). Every earlier attempt here tried to get the look out of blur
     * and tint alone and could not, because no amount of either is refraction.
     *
     * 0 disables it and the pane falls back to a plain frost — which is also
     * what happens on any engine that will not run the filter, so nothing
     * breaks, it simply stops looking like glass.
     *
     * ⚠️ Scale with the frame. 20 across a 350-wide pane is a soft bevel; past
     * about 60 the displacement samples from outside the picture and the edges
     * smear.
     */
    scale: 39,

    /**
     * Softening applied INSIDE the filter, after the three colour channels
     * recombine. `feGaussianBlur`'s standard deviation, in px.
     *
     * ⚠️ Deliberately small, and deliberately not a CSS `blur()` on top. The
     * three channels are displaced by different amounts to give the edge its
     * colour fringing; blurring hard afterwards averages that fringing straight
     * back to grey and throws away the one detail that reads as a lens.
     */
    blur: 3.9,

    /**
     * Saturation, applied alongside the filter.
     *
     * Glass concentrates colour slightly. 1 is untouched; much past 1.4 starts
     * looking like a filter rather than a material.
     */
    saturation: 1.32,

    /**
     * The frost's BLUR, in XD px — the plain CSS one, on the pane itself.
     *
     * Separate from `blur` above, which is the softening inside the SVG filter.
     * This one is the layer that cannot fail: it is an ordinary `blur()` with
     * no `url()` beside it, so it renders even where the lens does not.
     */
    frostBlur: 17,

    /**
     * The frost — a neutral wash over the pane, 0..1.
     *
     * ⚠️ SMALL, and NEUTRAL. This is not what obscures the picture; the
     * refraction is. It only gives the pane a body so white content is not
     * floating on bare photograph. It carried a blue-to-black gradient once and
     * that tint, not the glass, was doing all the work — a scrim wearing glass
     * as a costume, and it tinted everybody's skin.
     */
    frost: 0.117,
} as const;

/**
 * ── 10. Mirroring ───────────────────────────────────────────────────────────
 *
 * Whether a SELF-view is flipped left-to-right, like a mirror.
 *
 * ── Why this is one switch and not seven ────────────────────────────────────
 * It used to be seven: the SDK's own stylesheet, our override of it, a flag in
 * `useCamera`, three class names on FaceScanScreen, one on each screen that
 * displays a still, and a toggle on the bench. Turning mirroring off and on
 * again meant finding all of them, and the failure mode when one was missed is
 * the worst kind — the face flips between two steps and reads as a different
 * person's photograph, which looks like a capture bug rather than a CSS one.
 *
 * ⚠️ EVERY SITE MUST AGREE. The preview, the frozen frame, the intro avatar and
 * the comparison screen all show the same pixels; if any one of them disagrees
 * about this, the face reverses at that step. That is the entire reason this is
 * a single exported value.
 *
 * ── What it costs when it is false ──────────────────────────────────────────
 * A mirror is the natural self-view: you move left, the image moves left, which
 * is how a person lines their own face up. Unmirrored, that is reversed and
 * centring takes visibly longer — it is the first thing anyone notices and it
 * reads as the camera being wrong.
 *
 * ── What it does NOT touch ──────────────────────────────────────────────────
 * The captured pixels, ever. `captureFrame` and `grabFrame` read the sensor
 * through `drawImage`, which ignores CSS transforms entirely, so the stored
 * photograph is the raw frame whatever this says. This decides only what is
 * shown on screen — and therefore that every screen shows it the same way up.
 *
 * A DOCUMENT camera is never mirrored regardless: text on an ID would read
 * backwards. That is decided by facing mode in `useCamera`, not here.
 */
export const CAPTURE_MIRROR = {
    /** Mirror every self-view — the live preview and every still of it. */
    enabled: true,
} as const;

/**
 * The class that flips a self-view, or an empty string when mirroring is off.
 *
 * Exported as a ready-made class rather than a boolean so that every display
 * site reads `${MIRROR_CLASS}` and none of them re-derives the decision. It
 * also keeps the literal in exactly one place for Tailwind to find — a class
 * assembled from fragments at a call site is a class Tailwind never emits.
 */
export const MIRROR_CLASS = CAPTURE_MIRROR.enabled ? '-scale-x-100' : '';

/**
 * ── 11. The live camera's glass ─────────────────────────────────────────────
 *
 * A pane over the PREVIEW, heavy at the edges and clearing toward the middle,
 * so the frame reads as a lens with the person in the sharp centre of it.
 *
 * ── Why this is a second video and not `backdrop-filter` ────────────────────
 * Because `backdrop-filter` does not render at all on machines that are not
 * compositing on the GPU — established the hard way on the checking pane, where
 * it silently produced nothing, not even the blur. The checking pane solved
 * that by filtering a COPY of the photograph, which works because the thing
 * behind it is one image we already have.
 *
 * The live camera's backdrop is a video, and an `<img>` cannot copy one. So the
 * copy is a second `<video>` sharing the SAME `srcObject` — one camera, one
 * decode upstream, two elements displaying it. The copy is blurred and masked
 * with CSS; no render loop, no canvas, no per-frame JavaScript.
 *
 * ⚠️ It cannot affect the check. AWS reads the MediaStream track and its own
 * video's geometry; a second element displaying the same stream is invisible to
 * both. Same separation the retouched preview had.
 */
export const CAPTURE_LIVE_GLASS = {
    /** Off puts the plain camera back, with no second element mounted at all. */
    enabled: true,

    /**
     * ── THE TWO DIALS ───────────────────────────────────────────────────────
     *
     * How much liquid glass there is, at the two ends of the distance from the
     * person. Everything between them is the gradient; `falloff` below is its
     * shape.
     *
     *     minGlass   right at the person's edge — the LEAST glass
     *     maxGlass   at the frame's farthest corner — the MOST glass
     *
     * ⚠️ BOTH ARE PERCENTAGES, 0..100 — not fractions. The rest of this file is
     * in 0..1, and these two are the exception on purpose: they are the dials
     * that get asked for and changed in percent ("10 near me, 75 far"), and a
     * table you have to convert in your head before using is a table that gets
     * a 75 typed into it. `LivenessCamera` divides by 100 on the way out; CSS
     * never sees these numbers directly.
     *
     *     0    no pane at all. The camera, untouched.
     *     25   a faint haze. You can still read a sign on the wall.
     *     50   plainly glassed, but half the sharp picture still shows through.
     *     75   properly frosted — shapes and colour, no detail.
     *     100  the pane at full strength. Nothing of the sharp camera left.
     *
     * ⚠️ `maxGlass` IS A CEILING ON THE WHOLE EFFECT, and it is the number to
     * reach for when the glass "does not show". The pane is one layer over the
     * camera and this is how much of it is let through, so at 0.5 the frame's
     * border is always half the sharp picture NO MATTER how large `blur` or
     * `warpScale` get. Raising those only makes the half that shows heavier,
     * and past a point that reads as a double exposure rather than as glass.
     * If it is not strong enough, this is the dial — not those.
     *
     * ── Why min is near and max is far, and not the reverse ─────────────────
     * The face has to stay legible: the person is aligning themselves to an
     * oval they can only judge from what they see, and AWS times out waiting
     * for a fit that a softened preview makes harder to reach. Away from them
     * nothing is being judged, so that is where the material can be itself.
     */
    maxGlass: 75,
    minGlass: 10,

    /**
     * The clear hole's RADIUS, as a fraction of the frame's WIDTH.
     *
     * Only the starting value — `LivenessCamera` overwrites it a few times a
     * second from where the face actually is. It is what the pane is drawn with
     * until the first measurement lands, and whenever no face is found.
     *
     * ⚠️ THE FACE MUST NOT BE GLASSED. Not for looks — for the check. The oval
     * AWS measures against sits in the middle of the frame, the person is
     * judging their own position from what they see, and a softened face is one
     * they cannot align or read guidance against. The clear hole is sized to
     * hold a head at capture distance.
     *
     * ⚠️ Keep this in step with `@property --live-glass-clear`'s `initial-value`
     * in liveness.css. That registration is what gives the property a value
     * before the first measurement; this is only read by the inline style, and
     * the two disagreeing means the pane's first frames differ from its rest.
     */
    clear: 0.46,

    /**
     * Blur on the copy, in XD px.
     *
     * ⚠️ This is the strength of the PANE, which is not the same as how much
     * pane is shown — that is `edge` above, and it is a hard ceiling this
     * cannot climb over. At `edge: 0.5` the frame's border is always half the
     * sharp camera and half this, however large this gets, because the mask
     * only ever lets half of it through.
     *
     * So raising this makes the glassed half heavier, and past a point the
     * result stops reading as frosted glass and starts reading as a double
     * exposure — a sharp picture with a soft one ghosted over it. If the pane
     * still is not strong enough at 30, the number to raise is `edge`, not this
     * one.
     */
    blur: 30,

    /** Saturation on the copy — glass concentrates colour slightly. */
    saturation: 1.3,

    /**
     * How far the preview is BENT at the rim, in px — the LIQUID half.
     *
     * Same `GlassFilter` the checking pane uses, on the same displacement map:
     * nothing moves through the middle, deflection grows toward the border, and
     * the three colour channels are displaced by different amounts so edges
     * fringe the way they do through a real lens. Without this the pane is a
     * blur — a filter ON the camera rather than a sheet in front of it — which
     * is what it has been.
     *
     * ⚠️ MUCH SMALLER THAN THE CHECKING PANE'S 39, and not for looks. That one
     * bends a still: one frame, one composite, done. This one bends 30 frames a
     * second, live, on a device that is simultaneously encoding and uploading
     * video to Rekognition — and AWS errors any camera it measures below 15fps
     * (`CAMERA_FRAMERATE_ERROR`, already hit once in this codebase). A lens
     * strong enough to admire is a lens that can cost the sign-in.
     *
     * ⚠️ SET IT TO 0 FIRST if a check starts failing on framerate. That drops
     * the `url()` from the chain entirely and the pane falls back to the plain
     * blur, which is the behaviour this had before and cannot cost anything.
     * The `enabled` switch above is the bigger hammer.
     */
    warpScale: 20,

    /**
     * Softening inside the filter, after the channels recombine.
     *
     * Small, and for the same reason as the checking pane: blurring hard here
     * averages the colour fringing straight back to grey and throws away the
     * one detail that reads as a lens. The heavy softening is the CSS `blur`
     * above, which is a separate and much cheaper operation.
     */
    warpBlur: 1.4,

    /**
     * ── The PERSON is what stays clear, not a circle around their face ──────
     *
     * The glass covers the whole picture except the administrator — their head,
     * their shoulders, their arms — cut out along their actual outline.
     *
     * ── Why this is not the ellipse it replaced ─────────────────────────────
     * The ellipse was sized from a skin-tone estimate and could only ever be a
     * circle in the middle. That gets it wrong in both directions at once: the
     * shoulders and arms are glassed even though they are the person, and the
     * wall beside their head is clear even though it is the room. The falloff
     * looked right in a screenshot of somebody sitting perfectly centred and
     * wrong the moment anyone moved.
     *
     * The silhouette comes from the Selfie Segmenter — the same model the
     * capture's portrait blur uses, already vendored at
     * `/vendor/mediapipe/selfie_segmenter.tflite` and already warmed earlier in
     * this flow. `segmentToMask` returns a FEATHERED alpha, which matters: a
     * hard cut-out around hair is the artefact that sank the first portrait
     * attempt (see §4).
     *
     * ⚠️ THE COST IS THE WHOLE RISK, and it is on the one screen that cannot
     * absorb it. This is a neural network running while the device encodes and
     * uploads video to Rekognition, and AWS errors any camera it measures below
     * 15fps (`CAMERA_FRAMERATE_ERROR` — already hit once in this codebase).
     *
     * Three things keep it affordable, and none of them is optional:
     *   - it runs on `refreshMs`, not per frame. The BLUR is CSS on a video
     *     element and stays GPU-cheap at 60fps; only the outline is recomputed.
     *   - it runs at `maskWidth`, not at display resolution.
     *   - it never overlaps itself — a refresh already in flight blocks the
     *     next one, so a slow device silently drops to a lower rate instead of
     *     queueing work it cannot finish.
     *
     * ⚠️ TURN THIS OFF FIRST if a check starts failing on framerate. The pane
     * falls back to the ellipse mask in `liveness.css`, which is pure CSS and
     * costs nothing. `warpScale: 0` is the next lever, then `enabled` above.
     *
     * It also fails soft on its own: no model, no WebGL, or a mask claiming
     * less than 8% or more than 95% of the frame (`CAPTURE_PORTRAIT`'s sanity
     * bounds, which `segmentToMask` enforces), and the ellipse is what renders.
     */
    /**
     * The SHAPE of the falloff from the person out to the frame's corner.
     *
     * `[position, mix]` — position is the fraction of the way from the person
     * to the farthest corner; mix is how far between `centre` and `edge` the
     * pane is there. So `[0.22, 0.45]` reads: a fifth of the way out, the glass
     * is already nearly half way to full strength.
     *
     * ── Why this is not a straight line ─────────────────────────────────────
     * Because a straight line does not look like what it is. Interpolating
     * evenly from 0.1 at the person to 0.5 at the corner puts the pane at 0.3
     * halfway out — so most of the frame sits in the middle of the range and
     * the whole thing reads as ONE FLAT WASH with no sense of direction. The
     * falloff is there mathematically and invisible to look at.
     *
     * This curve rises fast and then flattens: the room is at four-fifths
     * strength by just past halfway and holds it, while the drop happens close
     * in, right around the person. That is what "stronger at the edges, easing
     * off as it approaches you" actually looks like — the change has to be
     * concentrated where the eye is, and the eye is on the face.
     *
     * ⚠️ Both mask paths read this — the silhouette's canvas ramp and the
     * ellipse fallback in liveness.css. Change the numbers and the stylesheet's
     * hand-written `calc()` stops must move with them, or the pane's appearance
     * changes at the moment segmentation takes over.
     */
    falloff: [
        [0, 0],
        [0.22, 0.45],
        [0.55, 0.82],
        [1, 1],
    ] as ReadonlyArray<readonly [number, number]>,

    /**
     * How far the gradient takes to climb from `minGlass` to `maxGlass`,
     * measured OUTWARD FROM THE PERSON'S OUTLINE, as a fraction of the frame's
     * width.
     *
     * ⚠️ FROM THE OUTLINE — not from their centre, and that distinction is the
     * whole reason the gradient was invisible.
     *
     * The first version measured distance from the face's CENTRE out to the
     * frame's corner. But the person is cut out of the pane, so the glass does
     * not begin until their silhouette ends — and by then most of the distance
     * to the corner has already been spent. Everything actually glassed sat in
     * the flat top of the curve at or near `maxGlass`, which is precisely the
     * "static, all one strength" it looked like. The gradient was real,
     * correct, and entirely inside the region that had been erased.
     *
     * Measuring from the outline puts the whole range where it can be seen:
     * `minGlass` hugging the person, climbing to `maxGlass` this far away.
     *
     * 0.4 — roughly the distance from a shoulder to the edge of the frame at
     * capture distance, so the climb completes right about where the picture
     * ends. Smaller concentrates the change near the person; larger spreads it
     * out and, past the point where nothing is that far from them, stops
     * reaching `maxGlass` anywhere at all.
     */
    spread: 0.4,

    /**
     * ── The pane stands down while the person is MOVING ─────────────────────
     *
     * The outline is recomputed every `refreshMs`, so between refreshes it
     * describes where somebody WAS. Hold still and that is invisible. Move —
     * which is the entire activity on this screen, since AWS is telling them to
     * come closer — and the cutout lags behind them, so the glass slides across
     * their face. It is at its worst exactly when they are doing what they were
     * asked to do.
     *
     * Chasing it with a faster refresh does not work: the lag is the model's
     * runtime, not the clock, and running a neural network more often on this
     * screen is what threatens the 15fps floor AWS fails a check below.
     *
     * So the pane fades out while they move and fades back once they settle.
     * A glassed room is decoration; a glassed face is an obstacle, and the
     * honest answer to "the mask is stale" is to not show a stale mask.
     *
     * Free to measure: `measureSkin` already reports where the face is for the
     * ramp, so this is the difference between two numbers it had anyway.
     */
    settle: {
        enabled: true,

        /**
         * How far the face may travel between measurements and still count as
         * still — in fractions of the frame, summed across position and size.
         *
         * Small enough to catch somebody leaning in, large enough to ignore the
         * measurement's own noise. ⚠️ This is a skin-tone estimate, so its
         * centre jitters by a percent or so even against a motionless face; set
         * this below that and the cutout never shrinks back.
         */
        moveThreshold: 0.014,

        /**
         * How long after the last movement the cutout stays grown, in ms.
         *
         * ⚠️ MUST EXCEED `silhouette.refreshMs`, or it tightens back onto the
         * outline that was already stale when they stopped — the exact artefact
         * it exists to prevent, half a second later. Longer than the refresh
         * guarantees a fresh mask lands before it narrows.
         */
        holdMs: 620,

        /**
         * How far the cutout is GROWN while they move, as a fraction of the
         * frame's width.
         *
         * ── What this replaced, and why ─────────────────────────────────────
         * The first version of this faded the whole pane out while anyone
         * moved, which was wrong twice over: the glass disappeared on the
         * smallest shift, and it took the ROOM's glass with it — when the only
         * thing at risk was the person. The room is not stale; it is not
         * moving.
         *
         * So the pane stays exactly where it is and only the cutout changes.
         * Moving widens the clear area enough to cover wherever the person has
         * got to since the outline was computed; holding still lets it settle
         * back onto them. The glass over everything else never flinches.
         *
         * Sized against how far somebody travels in one refresh: at 400ms, a
         * normal lean toward the camera moves their edge a few percent of the
         * frame, so 6% covers it with room to spare.
         */
        grow: 0.06,
    },

    silhouette: {
        enabled: true,

        /**
         * How often the outline is recomputed, in ms.
         *
         * Slower than the face track's 320ms on purpose — this is a whole
         * neural network against a per-pixel scan that costs single digits.
         * A head and shoulders do not change OUTLINE appreciably in 400ms;
         * they change position, and the feathered edge absorbs that.
         */
        refreshMs: 400,

        /**
         * Width the segmenter is fed, in px. Height follows the frame's shape.
         *
         * The model resamples its input to 256x256 internally, so feeding it
         * more than this buys nothing at all — it only costs the `drawImage`
         * and the per-pixel label scan, both of which are linear in this
         * number. The resulting mask is upscaled to the frame, which is
         * harmless because it is a feathered silhouette rather than detail.
         */
        maskWidth: 160,

        /**
         * Consecutive failures before this stops trying for the rest of the
         * check.
         *
         * A missing model or a dead WebGL context fails every time, and
         * retrying it two and a half times a second for the length of a
         * liveness check is pure cost against an answer that will not change.
         * A few attempts covers the case that actually recovers — the model
         * still downloading — without grinding on the one that cannot.
         */
        giveUpAfter: 6,
    },
} as const;

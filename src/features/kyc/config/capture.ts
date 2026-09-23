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
 * ── 11b. The face mesh on the live camera ───────────────────────────────────
 *
 * The 478-point Face Mesh drawn over the preview, shining and sparkling the way
 * the AI mark and the Face ID glyph do, and tracking the face smoothly.
 *
 * ⚠️ THIS EXISTED BEFORE AND WAS REMOVED. `LivenessCamera` still carries the
 * note: it drew a second ML model's landmarks over AWS's camera and "did not
 * read well" — a flat green wireframe on a face. What is different this time is
 * only the drawing: the same landmarks, dressed like the rest of this flow.
 * If it reads as a debug overlay again, that is the failure mode to watch for.
 *
 * ── Two clocks, and that is the whole design ────────────────────────────────
 * "Smooth, high frame rate" and "a neural network per frame" are different
 * requests, and only the first one is wanted. So:
 *
 *   DETECT runs at `detectFps` — the model, throttled.
 *   DRAW runs on requestAnimationFrame — every frame the display has.
 *
 * Between detections the mesh EASES toward the latest landmarks (`smoothing`)
 * rather than holding still, so it moves at the display's rate while the model
 * runs at a fraction of it. Detecting per frame would look no better: the
 * model's own output jitters, and this filter is what removes that.
 *
 * ⚠️ It is still the largest CPU cost on this screen, and this screen already
 * encodes and uploads video to Rekognition — which errors below 15fps
 * (`CAMERA_FRAMERATE_ERROR`, hit once here already). `detectFps` is the lever;
 * `enabled` is the hammer. Both are cheaper to reach for than debugging a
 * liveness check that fails only on weak devices.
 */
export const CAPTURE_LIVE_MESH = {
    enabled: true,

    /**
     * How often the landmarks are recomputed, per second.
     *
     * NOT the frame rate of the animation — see the two-clock note above. 22 is
     * comfortably above the rate at which a head changes shape on screen, and
     * roughly a third of the work of running it per frame.
     */
    detectFps: 22,

    /**
     * How far each drawn frame moves toward the latest landmarks, 0..1.
     *
     * An exponential filter, and it does two jobs at once: it fills the gaps
     * between detections with motion, and it removes the model's own per-frame
     * jitter. Lower is smoother and laggier. Above ~0.6 the jitter comes back;
     * below ~0.15 the mesh visibly swims behind the face.
     */
    smoothing: 0.34,

    /**
     * ── The wireframe: TRIANGLES, drawn as triangles ────────────────────────
     *
     * Every edge of MediaPipe's tessellation, stroked where it actually is.
     *
     * ⚠️ DO NOT CHAIN THESE INTO PATHS. A previous version walked the
     * adjacency into long continuous runs so a dashed stroke could travel along
     * them — and a greedy walk through a triangulation WANDERS. Thinning those
     * runs by dropping vertices then cut across the triangles they came from.
     * The result was not a mesh at all: it was a few hundred zigzag threads
     * over somebody's face, which is precisely how it looked. The triangles are
     * the geometry; keeping them intact is the whole requirement.
     *
     * Drawn as ONE path and ONE stroke, so ~2600 segments cost a single call.
     */

    /**
     * How big the triangles are — the clustering cell, as a fraction of the
     * FACE's own width.
     *
     * ⚠️ THE ONE KNOB FOR "too many short lines". Raise it for fewer, larger
     * triangles; lower it toward MediaPipe's own density.
     *
     * ── Why the mesh is rebuilt rather than filtered ────────────────────────
     * The tessellation is 478 points over one face, so its triangles are a few
     * pixels across: dense, overlapping to the eye, and nothing like the
     * low-poly geometry this wants to be. Dropping edges from it does not help
     * — it leaves the same tiny triangles with holes punched in them, which is
     * worse.
     *
     * So the landmarks are CLUSTERED: the face is divided into cells this big,
     * every landmark in a cell collapses to one representative, and each
     * original edge is redrawn between its endpoints' representatives.
     * Duplicates fold together and edges inside a cell vanish. The result is a
     * genuine coarse triangulation of the same face, with the same topology.
     *
     * ⚠️ Measured against the FACE, not the frame, and built ONCE from the
     * first detection. Both matter: against the frame, the triangles would get
     * finer as somebody leaned toward the camera, and rebuilt per frame the
     * whole wireframe would reshuffle whenever a landmark crossed a cell
     * boundary — a mesh that flickers between two topologies several times a
     * second, which is far more distracting than one that is slightly too fine.
     */
    /*
     * 0.095 — the middle ground, and the range is worth recording since both
     * ends have now been seen:
     *
     *   0      MediaPipe's own density. A grey haze of overlapping hairlines.
     *   0.095  here. Clearly triangles, still enough of them to describe a face.
     *   0.17   too few. Reads as a polygon shell laid over somebody rather than
     *          as a mesh on them.
     *
     * Cell area scales with the square of this, so triangle COUNT scales with
     * its inverse square: halving it is roughly four times the lines. Move it
     * in small steps.
     */
    cellSize: 0.095,

    /** Stroke width in XD px. Hairline — this is a tracery, not a cage. */
    lineWidth: 0.6,

    /**
     * Opacity of the wireframe — STEADY. It never animates.
     *
     * ⚠️ The lines do not shine and must not. A version that ran light along
     * them lit hundreds of segments at once, so the geometry never held still
     * long enough to be read AS geometry and the dots had nothing to be
     * distinct from. The mesh is a fixed structure; the dots are the only thing
     * that moves on it.
     *
     * Raised from 0.16 once the glass oval went in behind it. The two are
     * related and should move together: the pane softens and slightly flattens
     * what is under the wireframe, so the same alpha that was right over a
     * sharp, busy face is too faint over a calm one. Part of the pane's job is
     * to let this be legible without being loud — see `CAPTURE_LIVE_GLASS`.
     */
    baseAlpha: 0.22,

    /**
     * ── The gems ────────────────────────────────────────────────────────────
     *
     * A handful of points that sit ON mesh vertices, flare, fade out, and come
     * back somewhere else.
     *
     * ⚠️ NOT a dashed stroke travelling the lines. That was the previous
     * attempt and it can only ever look like threads moving, because it IS the
     * line being drawn in pieces — the light has to slide continuously along a
     * path. A gem does not slide: it appears, shines and is gone, and the next
     * one is elsewhere. Discrete points with independent lifetimes are the only
     * way to get that.
     */

    /** How many are alive at once. Small — this is a sparkle, not a starfield. */
    dotCount: 9,

    /**
     * How long one lives, in ms — a range, sampled per gem.
     *
     * ⚠️ A RANGE, not a value. With one fixed lifetime the whole set drifts
     * into step within a few cycles and then blinks together, which reads as a
     * loading indicator. Independent random lifetimes are what keep the
     * alternation looking unplanned. Same reasoning as the AI mark's three
     * durations, taken further because there are nine of these.
     */
    dotMinLifeMs: 850,
    dotMaxLifeMs: 2200,

    /** Radius of the bright core, in XD px. The halo is drawn around it. */
    dotRadius: 2.2,

    /**
     * Cap on the overlay's pixel ratio.
     *
     * A phone at devicePixelRatio 3 would rasterise this at 1050x1200 every
     * frame for a tracery of hairlines nobody is inspecting. 2 is past the
     * point where the lines stop looking stepped.
     */
    maxDpr: 2,
} as const;

/**
 * ── 11c. The viewfinder's zoom, and the mesh's fill ─────────────────────────
 *
 * Two things that both hang off AWS's match bar.
 *
 * ── ⚠️ THE ZOOM IS DISPLAY-ONLY. IT CANNOT HELP ANYONE PASS ─────────────────
 * It has to be said here because the opposite is the obvious reason to want it.
 *
 * AWS issues its oval in the session at about 97% of the STREAM's height and
 * measures face fit against the stream. The required face-to-frame ratio is
 * therefore proportional: magnify the picture and the oval magnifies with it.
 * A lens zoom is worse still — it crops the field of view, so the head-room
 * goes and the person has to come CLOSER. That was tried and reverted
 * (`git log` 5d7f21c); see §2.
 *
 * The only way to make AWS see a larger face is to feed the detector a cropped,
 * upscaled copy of the camera instead of the camera. That is out of the
 * question: it is modified video entering the anti-spoofing path, it degrades
 * the frames the freshness measurement reads, and it makes a liveness check
 * easier to pass. A security regression wearing a UI change.
 *
 * So this scales what is ON SCREEN and nothing else. AWS's stream, its bar, its
 * hints and the captured photograph are all untouched — the capture is drawn
 * from the video's decoded frames, which ignore CSS transforms entirely (the
 * same mechanism that keeps `CAPTURE_MIRROR` out of the stored image).
 *
 * What it is FOR: the mesh and the glass are the feedback, and at arm's length
 * they are small. Magnifying the viewfinder makes them readable while the
 * person is deciding how to move.
 *
 * ⚠️ AND IT RELEASES BEFORE THE SHUTTER. Held at the moment the frame is kept,
 * every screen afterwards — the verdict, the comparison, the avatar — would
 * show a picture framed differently from the one the person was just looking
 * at. See `releaseAt`.
 */
export const CAPTURE_LIVE_ZOOM = {
    /**
     * ⚠️ OFF — it was built, tried, and it LIES TO THE USER.
     *
     * Observed 2026-09-23: with the zoom on, the face filled about 90% of the
     * frame while AWS's bar sat at 20% and its hint still read "Move a little
     * closer". Both are correct — the bar measures the STREAM and the zoom only
     * magnified the screen — but the person cannot see that. The picture says
     * "you have arrived" and the text says "keep going", and the picture wins.
     * They stop moving, the bar never fills, and the check times out.
     *
     * That is worse than no zoom: it does not merely fail to help, it actively
     * works against the instruction beside it.
     *
     * ── What would make it honest ───────────────────────────────────────────
     * A visible TARGET that scales with it. If AWS's oval guide is on screen
     * and is magnified by the same transform, then the face and the thing it
     * has to fill grow together — the relationship the person is judging is
     * preserved, and the zoom becomes what it was meant to be: a magnifying
     * glass over the whole feedback loop rather than over half of it.
     *
     * That is one change away. The oval canvas is currently `opacity: 0` (see
     * liveness.css, which carries the exact recipe for bringing the ring back),
     * and it is a SIBLING of the video inside `.amplify-liveness-video-anchor`
     * — so transforming the anchor instead of the video would scale the guide
     * and the face as one, for free.
     *
     * Until the guide is back, this stays off. The code below is correct and
     * costs nothing while disabled: `handleMeshBounds` returns before writing
     * any transform, and the sampling loop keeps ownership of the mirror.
     */
    enabled: false,

    /**
     * How large the face is allowed to become, as a fraction of the frame's
     * width — the zoom is whatever multiple gets the mesh to this size.
     *
     * Driven from the mesh's own bounding box, so it is a real measurement of
     * the face rather than of the person.
     */
    targetWidth: 0.62,

    /**
     * The most the viewfinder may be magnified.
     *
     * ⚠️ Low, and not for taste. This is a DIGITAL zoom on a preview: every
     * multiple throws away resolution, and the mesh's hairlines are the first
     * thing to go soft. Past about 1.6 the thing being magnified for legibility
     * stops being legible.
     */
    max: 1.55,

    /**
     * How far the bar must fill before the zoom lets go, 0..1.
     *
     * Slightly under 1: AWS asks the person to hold still at the top of the
     * bar, and the release has to have COMPLETED by the time the shutter fires
     * or the frame is kept mid-animation. Starting it a little early costs
     * nothing — by then they are in position and no longer reading the mesh.
     */
    releaseAt: 0.9,

    /**
     * How long the zoom takes to move, in ms.
     *
     * Slow. The viewfinder is tracking a face that is itself moving, and a
     * quick follow turns every lean into a lurch of the whole picture — which
     * is both unpleasant and makes the person over-correct. This is a camera
     * operator, not a spring.
     */
    ms: 620,
} as const;

/**
 * ── 11e. The CAMERA's zoom ──────────────────────────────────────────────────
 *
 * `track.applyConstraints({ advanced: [{ zoom }] })` — the camera's own zoom,
 * so the person can sit further back and still fill AWS's oval.
 *
 * ── ⚠️ THIS ONE REALLY DOES MOVE THE BAR, unlike §11c ───────────────────────
 * The distinction is the whole reason both exist, and it is worth stating in
 * full because the two look identical on screen.
 *
 * A DISPLAY zoom (§11c) is a CSS transform. It happens in the compositor,
 * after decode, and changes only painting. Confirmed in the SDK's own source:
 * the bar is an IoU between a face box from `detectFaces(videoEl)` — the
 * element's DECODED frames — and an oval from
 * `getOvalDetailsFromSessionInformation({ videoWidth })`. Neither reads a
 * transform, so the bar does not move. That version is off for exactly this
 * reason: it showed a face filling the frame beside a bar reading 20%.
 *
 * A CAMERA zoom changes the STREAM. The field of view narrows, so the face
 * occupies more of the 1280x960 — while the oval, derived from `videoWidth`,
 * stays exactly the same size. The IoU rises. The bar fills. It is the same
 * thing as fitting a longer lens, and the frames AWS analyses are still
 * genuine, full-pipeline camera output.
 *
 * ⚠️ WHAT IS NOT ACCEPTABLE, for the avoidance of doubt: cropping and
 * re-encoding the stream through a canvas to hand the detector a bigger face.
 * That is modified video entering the anti-spoofing path, it degrades the
 * frames the freshness measurement reads, and it makes a liveness check easier
 * to pass. A camera control is a camera. A re-encode is a forgery.
 *
 * ── The cost, so it is a decision ───────────────────────────────────────────
 * Zoom crops the sensor, so the PHOTOGRAPH comes out tighter — which is
 * precisely the complaint that got an earlier zoom experiment reverted (§2,
 * "it is a face and nothing else"). `releaseAt` is the answer: the zoom goes
 * back to 1 before the shutter, and the frames kept after that are the ones
 * filed. It also costs resolution, on a capture that §1 spent real effort
 * making sharper.
 */
export const CAPTURE_CAMERA_ZOOM = {
    enabled: true,

    /**
     * How far past the camera's OWN minimum it may zoom.
     *
     * ⚠️ Relative, not absolute. The `zoom` capability has no standard unit —
     * some devices report 1..8, others 100..800 — so the only portable reading
     * is "a multiple of `capabilities.zoom.min`". An absolute 1.5 would be no
     * zoom at all on the second kind of camera and would be silently ignored.
     *
     * ── Why 3 and not 1.5 ───────────────────────────────────────────────────
     * 1.5 was set when the loop could only ramp UP, where a low ceiling was the
     * only protection against zooming past the oval and stranding somebody at
     * "move a little away". It stopped an iPhone dead at half a bar: the
     * ceiling bound long before the bar filled, the clamp reversed the
     * direction, and it sat there oscillating.
     *
     * Overshoot is now the controller's problem, not this number's — AWS says
     * "move away", the direction flips, and it settles. So this is no longer a
     * safety limit. It is an IMAGE QUALITY limit: zoom crops the sensor, and
     * past about 3x the stream AWS is analysing has lost enough detail to start
     * costing the anti-spoofing measurement, on a capture §1 spent real effort
     * sharpening.
     */
    max: 3,

    /**
     * ── IT KEEPS GOING UNTIL AWS'S BAR IS FULL ──────────────────────────────
     *
     * The controller is closed-loop on the BAR, not on a face size.
     *
     * ⚠️ An earlier version aimed at a face width — "make the face 55% of the
     * frame" — and it stopped there with the bar at a third. That number was a
     * guess at what AWS wants, and AWS does not want a width: it wants an
     * intersection-over-union against an oval whose size comes from the session.
     * Any face-size target is a second opinion about the only question that
     * matters, and it was wrong. So the loop now watches the answer instead of
     * predicting it, and stops when the answer says so.
     */

    /** Keep zooming until the bar reaches this, 0..1. */
    fillTo: 1,

    /**
     * How full the bar must be to count as LOCKED — the point at which the zoom
     * is given back.
     *
     * ⚠️ THE TIMING HERE IS LOAD-BEARING IN BOTH DIRECTIONS, and the state
     * machine is what makes it safe.
     *
     * Release too EARLY and the zoom that filled the bar is taken away before
     * the match locks, the face shrinks, and the check goes straight back to
     * "move a little closer". The zoom would be undoing its own work.
     *
     * Release too LATE and the photograph is one taken through a cropped
     * sensor, which is the complaint that got an earlier zoom experiment
     * reverted (§2).
     *
     * The gap between them exists because of how the SDK is built. In
     * `machine.mjs`, `checkMatch` moves to `handleChallenge` the moment
     * `hasFaceMatchedInOval` is true and NEVER RETURNS to `ovalMatching` — the
     * oval is not re-tested after the lock. What follows is a one-second
     * "hold still" pause and then the freshness flash, neither of which looks
     * at face position. So the whole of that window is ours: the camera can go
     * back to normal, and the frames sampled through it are unzoomed and are
     * the ones filed.
     *
     * 0.99 rather than 1 only to avoid depending on a float landing exactly on
     * its cap.
     */
    lockAt: 0.99,

    /**
     * How full the bar must ALSO be for AWS's "hold still" to count as the
     * lock, 0..1.
     *
     * ⚠️ The bar alone is not a reliable lock signal, which is why there are
     * two. `getFaceMatchStateInLivenessOval` returns MATCHED from either of two
     * conditions — the IoU clearing its threshold, or `isFaceMatchedClosely` —
     * and only the first drives the percentage to 100. So a person who arrives
     * by the second route locks the match with the bar still short of
     * `lockAt`, the release never fires, and the zoom stays in for the whole
     * capture. That is the "it does not zoom out at hold still" report.
     *
     * The hint catches that case: when the SDK asks somebody to hold, it has
     * decided. This guard only exists because the same string is also shown
     * much earlier, when a face is first detected and nothing has been matched
     * at all — half a bar separates the two situations comfortably.
     */
    holdAt: 0.5,

    /**
     * How far the bar must fall after a step before the loop reverses.
     *
     * ⚠️ IT REVERSES — it does not stop. An earlier version latched a `peaked`
     * flag the first time the bar dipped and never zoomed again for the rest of
     * the check. The bar is noisy (a blink, a small turn of the head), so one
     * transient dip disabled the whole thing, and it was reported as the zoom
     * stopping halfway. A controller on a noisy signal may not have a state it
     * cannot leave.
     *
     * The margin is what keeps it from chasing that noise: a fall smaller than
     * this is not treated as evidence of anything.
     */
    backOff: 0.05,

    /**
     * The most the zoom may change in one adjustment, as a multiple.
     *
     * ⚠️ SMALL, and paired with `stepMs`. Together they set how the motion
     * READS, not how fast it gets there: 12% every 600ms and 4% every 200ms
     * arrive at the same place in the same time, but the first is three visible
     * jumps a second and the second is a glide. It was reported as "like
     * steps", and that is exactly what it was.
     *
     * There is no cost to the finer grain. `applyConstraints` is only issued
     * when the previous one has settled (see the in-flight guard in
     * `LivenessCamera`), so a camera that cannot keep up simply moves in larger
     * intervals of its own accord rather than accumulating a queue of requests
     * behind it.
     */
    maxStep: 0.04,

    /**
     * Shortest gap between adjustments, in ms.
     *
     * A floor, not a schedule — the real pacing comes from the device, because
     * the next request does not go out until the last one has completed.
     */
    stepMs: 200,

    /**
     * What the zoom is MULTIPLIED BY once the match locks, 0..1.
     *
     * 0.5 halves it: 6x becomes 3x, 4x becomes 2x.
     *
     * ⚠️ A MULTIPLE OF THE ZOOM, not of the distance above the camera's
     * minimum. The difference is small at 2x and wrong at 6x — interpolating
     * toward `min` gives `1 + (6 - 1) x 0.5 = 3.5`, which is not half of
     * anything anybody asked for. The zoom is a ratio, so the thing to halve is
     * the ratio.
     *
     * ── Why it is not 0 ────────────────────────────────────────────────────
     * The capture has to look like what the person was looking at. Dropping the
     * whole way back at the moment AWS says "hold still" pulls the face
     * abruptly small right as it is photographed, and the still that gets filed
     * is framed nothing like the preview they had just settled into.
     *
     * Half is the compromise: the tightest crop is gone — which is what
     * protected the photograph from the complaint in §2 — while the framing
     * stays close to what was on screen a second earlier. The pull-back eases
     * at `maxStep` like every other move, so it glides rather than snapping.
     */
    releaseTo: 0.5,
} as const;

/**
 * ── 11d. The mesh's fill ────────────────────────────────────────────────────
 *
 * As AWS's match bar fills, the wireframe turns green from the chin upward.
 *
 * ⚠️ NOT a colour gradient over the whole mesh. A share of the LINES equal to
 * the bar's fraction is green and the rest stays white, so the mesh reads as a
 * gauge — the eye counts how much of it has changed, which is a quantity, where
 * a blend of two colours is just a tint and says nothing about how far along
 * anybody is.
 *
 * The gems follow the same proportion: each decides at birth whether it is
 * green, with probability equal to the fill. So they shift from white to green
 * gradually and without any of them changing colour mid-flare.
 *
 * The bar itself is read from AWS's own DOM — `aria-valuenow` on
 * `.amplify-liveness-match-indicator__bar`. It is their number, reported by
 * them, so this cannot disagree with what the check actually thinks.
 */
export const CAPTURE_MESH_FILL = {
    enabled: true,

    /** The filled colour. The same green the passed verdict uses. */
    colour: '#34C759',

    /**
     * How fast the fill eases toward the bar, 0..1 per frame.
     *
     * The bar is read a few times a second and jumps in steps; easing turns
     * that into a rise. Slower than the mesh's own smoothing because a gauge
     * that snaps backward on a momentary bad reading looks like a fault.
     */
    smoothing: 0.08,
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
     * ── WHAT THIS PANE IS FOR ───────────────────────────────────────────────
     *
     * Two jobs, and every number below is set against them rather than against
     * "make it look like glass":
     *
     *   1. SOFTEN A CLOSE-UP. AWS's oval makes the person fill the frame, so
     *      they are inches from a wide lens — which stretches whatever is
     *      nearest it. Noses enlarge, cheeks flatten, and people read that as
     *      the app taking a bad picture of them. A soft-focus pane over the
     *      face takes the edge off it.
     *   2. GIVE THE MESH SOMETHING TO SIT ON. A white hairline wireframe over a
     *      sharp, busy face competes with the detail underneath it. Over a
     *      softened one it separates cleanly, and the eye goes to the mesh —
     *      which is the point of drawing it.
     *
     * ⚠️ BOTH ARGUE AGAINST A STRONG WARP, and that is not obvious. Refraction
     * is the signature of the material, but it is also DISTORTION — and this
     * pane exists to make a distorted picture look less distorted. Bending it
     * further fights the first job outright and blurs the mesh's backdrop into
     * motion the second one has to compete with. `warpScale` is deliberately
     * low here for that reason, and not because of cost.
     *
     * ── THE ONE DIAL ────────────────────────────────────────────────────────
     *
     * How much liquid glass sits on the face, as a PERCENTAGE.
     *
     *     0    no pane at all. The camera, untouched.
     *     25   a faint haze. You can still read fine detail through it.
     *     40   here. Plainly a pane, and the face still legible behind it.
     *     75   properly frosted — shapes and colour, no detail.
     *     100  full strength. Nothing of the sharp camera left.
     *
     * ⚠️ 0..100, not 0..1, unlike the rest of this file. Deliberate: this is
     * the number that gets asked for and changed in percent. `LivenessCamera`
     * divides by 100 on the way out — CSS alpha is 0..1, and handing the parser
     * a 40 is not "40%", it is an out-of-range value that clamps to fully
     * opaque.
     *
     * ── What this replaced ──────────────────────────────────────────────────
     * A pane over everything EXCEPT the person, ramping 10→75 outward from
     * their outline. It is gone, along with `minGlass`, `maxGlass`, `spread`
     * and the clear cut-out: the glass is now an OVAL ON the face, with the
     * mesh drawn over it. The two are opposites, and nothing of the gradient
     * version survives — if any of those names reappear, they are from a
     * revert.
     */
    glass: 75,

    /**
     * How much larger than the MESH the oval is drawn.
     *
     * ⚠️ The oval is sized from the face mesh's own bounding box, not from a
     * skin estimate. `FaceMesh` reports its bounds every detection and they
     * drive this pane directly — so the glass is exactly the wireframe's
     * footprint, which is what "just the size of the mesh, behind it" means and
     * is something no separate measurement could stay in step with.
     *
     * A few percent of margin only, so the feathered rim has somewhere to fade
     * and the outermost triangles are not sitting on the cut.
     *
     * `measureSkin` remains the FALLBACK, for the window before the mesh model
     * has loaded and whenever it finds no face — see `face` below.
     */
    ovalPad: 1.06,

    /**
     * How much of the oval's radius is spent fading out at its rim, 0..1.
     *
     * ⚠️ Not decoration. A hard-edged ellipse of frost on a face reads as a
     * sticker — the eye finds the cut instantly, and it is the single thing
     * that makes an overlay look pasted on rather than present. Feathering the
     * last fifth is what makes it a pane the face is behind.
     */
    ovalFeather: 0.22,

    /**
     * Blur on the copy, in XD px.
     *
     * ⚠️ This is the strength of the PANE, which is not the same as how much
     * pane is shown — that is `glass` above, and it is a hard ceiling this
     * cannot climb over. At `glass: 40` the oval is always 60% the sharp
     * camera, however large this gets, because the mask only lets 40% of it
     * through. If the pane is not strong enough, `glass` is the dial, not this.
     *
     * ⚠️ 16 and not 30, and the reason is the first job above. A sharp picture
     * with a 40% copy of itself blurred over it is the soft-focus every
     * portrait lens filter does — but only while the blur stays NEAR the
     * features it is softening. Taken far, the soft copy stops corresponding to
     * anything and lands as a second, wider face over the first: a double
     * exposure, which is more distracting than the distortion it was meant to
     * hide, not less. 16 is about an eye's width at capture distance, which is
     * the range over which softening still reads as softening.
     */
    blur: 16,

    /** Saturation on the copy — glass concentrates colour slightly. */
    saturation: 1.3,

    /*
     * ⚠️ NO `warpScale` / `warpBlur` HERE ANY MORE. They were the SVG
     * refraction, and both reasons they went are worth keeping:
     *
     *   - the pane is a `backdrop-filter` now, because a second <video> on the
     *     same MediaStream does not play on iOS and the glass simply never
     *     appeared there. An SVG `url()` inside a `backdrop-filter` is the trap
     *     that cost three earlier rounds — it passes `@supports`, fails at
     *     paint, and takes the whole declaration down with it;
     *   - refraction is DISTORTION, and the first job at the top of this table
     *     is to make a close-up lens look LESS distorted. The warp was already
     *     cut from 20 to 8 for that reason before it went entirely.
     *
     * The CHECKING pane still refracts — it stands over a still <img>, where
     * `filter` on a copy works everywhere. See `CAPTURE_CHECKING_GLASS`.
     */

    /**
     * Where the oval sits and how big it is, until the first measurement.
     *
     * Only the starting values — `LivenessCamera` overwrites them from
     * `measureSkin` a few times a second, and they are what the pane is drawn
     * with before that lands and whenever no face is found.
     *
     * ⚠️ Keep in step with the `@property` initial values in liveness.css.
     * Those registrations are what give the custom properties a value before
     * the first measurement; these are only read by the inline style, and the
     * two disagreeing means the pane's first frames differ from its rest.
     */
    face: 0.3,
    faceX: 0.5,
    faceY: 0.42,
} as const;

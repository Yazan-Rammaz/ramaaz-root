/**
 * Where `FaceLivenessDetectorCore` loads its two runtime files from.
 *
 * ── Why not AWS's defaults ──────────────────────────────────────────────────
 * Core fetches its TensorFlow WASM backend from cdn.jsdelivr.net and its
 * Blazeface model from tfhub.dev. Both are blocked here — `script-src` and
 * `connect-src` are `'self'` deliberately — and a sign-in that depends on two
 * third-party CDNs staying up is a sign-in with two extra ways to fail. So both
 * are vendored into /public/vendor by scripts/sync-vendor.mjs, the same
 * treatment opencv.js and MediaPipe already get.
 *
 * ── Why the model URL is absolute and the wasm path is not ──────────────────
 * They are consumed by different code and only one is fussy.
 *
 * `binaryPath` is handed to `tf.setWasmPaths()` as a prefix, which resolves
 * against the document like any other relative URL. A leading-slash path is
 * fine, and it is what ships.
 *
 * `faceModelUrl` is NOT. Amplify rejects a relative value outright, with:
 *
 *     "There was an error loading the blazeface model. If you are using a
 *      custom blazeface model url ensure that it is a fully qualified url
 *      that returns a json file."
 *
 * and surfaces it as `RUNTIME_ERROR` — a category, not a cause, which is why
 * this cost an evening. The request for /vendor/blazeface/model.json is even
 * made and answered 200 before the check rejects it, so the network tab shows
 * a healthy load and the screen shows a failure.
 *
 * Hence a function rather than a constant: the origin is only knowable in the
 * browser, and a module-level `location.origin` would throw during SSR. Every
 * caller renders the detector behind an async gate, so `window` always exists
 * by the time this is read.
 */

export const TFJS_WASM_PATH = '/vendor/tfjs-wasm/';

const BLAZEFACE_MODEL_PATH = '/vendor/blazeface/model.json';

/** Absolute URL of the vendored Blazeface model. Browser-only — see above. */
export function blazefaceModelUrl(): string {
    return new URL(BLAZEFACE_MODEL_PATH, window.location.origin).href;
}

/**
 * How far to zoom the camera in before the check runs. 1 = off.
 *
 * ── Why this is the only way to stand further back ──────────────────────────
 * The distance AWS demands is not ours to set. The oval and every threshold
 * measured against it arrive from the service in the session
 * (`Challenge.OvalParameters` and `Challenge.ChallengeConfig`, read in
 * `getFaceMatchStateInLivenessOval`); the browser only draws what it is sent,
 * and `CreateFaceLivenessSession` takes no parameter for either. There is not
 * even a "too close" state in their matcher — anything that is not a match
 * falls through to TOO_FAR, which is why the hint is always "move closer".
 *
 * And it is a demanding oval: with `OVAL_HEIGHT_WIDTH_RATIO = 1.618` against
 * the 640x480 stream they ask for, its height works out at about 97% of the
 * frame. The face has to fill the picture almost top to bottom.
 *
 * So the requirement cannot be lowered — but what the camera SEES can be
 * narrowed, which comes to the same thing for the person in front of it. At 2x
 * the face is twice the size at the same distance, so the same oval is filled
 * from twice as far away.
 *
 * ⚠️ It costs image quality, knowingly. Zoom is a crop: fewer real pixels land
 * on the face, and those pixels are what the anti-spoofing measurement is made
 * of. Expect `livenessConfidence` to fall. Accepted deliberately — an
 * administrator who cannot complete the check at all is worse than one whose
 * score is lower — but it is the number to watch on the bench
 * (`/design/liveness-lab`) when tuning this, because the whole point of that
 * check is the margin between a live face and a spoof.
 *
 * ⚠️ Not every camera can do it. `zoom` is a capability the device advertises;
 * most laptop webcams do not, and there it is a silent no-op. Phones generally
 * do. `LivenessCamera` logs which happened and reports it to `onCameraZoom`,
 * which the bench puts on screen — worth checking before tuning this number,
 * since on a device with no zoom every value here does the same nothing.
 *
 * It is also clamped to what the device advertises, so asking for more than the
 * hardware has gets the hardware's maximum rather than a refusal.
 */
export const CAMERA_ZOOM = 3;

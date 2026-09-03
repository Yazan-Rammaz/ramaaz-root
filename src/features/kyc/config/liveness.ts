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

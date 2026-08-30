#!/usr/bin/env node
/**
 * Populates public/vendor with the two runtimes ID capture needs.
 *
 * Both are loaded by the browser during ID capture:
 *   opencv.js   — finds the document's four corners
 *   mediapipe/  — face landmarker, used to tell an ID's photo side from its back
 *
 * They must be served from our own origin. The CSP is
 * `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`, so pulling them from
 * cdn.jsdelivr.net / docs.opencv.org is blocked — and a KYC flow should not
 * depend on third-party hosting at runtime regardless.
 *
 * public/vendor is gitignored (~43 MB). Committing it here would bloat rdb's
 * history permanently, and ID capture is scheduled to move to the ramaaz-kyc
 * repo — where these files will be committed properly. Until then this script
 * runs on postinstall so a fresh clone just works.
 *
 * MediaPipe's WASM is copied from node_modules (never downloaded) so the served
 * copy cannot drift from the installed @mediapipe/tasks-vision version. The
 * MODEL is a separate matter — see below.
 *
 * Run manually with:  npm run sync:vendor
 */
import { mkdirSync, readdirSync, copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
/** Sanity floor — the real file is ~10.5 MB; anything smaller is an error page. */
const OPENCV_MIN_BYTES = 5 * 1024 * 1024;

/**
 * The face landmarker MODEL — and the reason this block exists.
 *
 * @mediapipe/tasks-vision ships the WASM runtime but NOT the .task weights, so
 * copying node_modules/**\/wasm (above) produces a vendor directory that looks
 * complete and is not. Because public/vendor is gitignored, the gap is
 * invisible on any machine where someone once fetched the file by hand — and
 * fatal on every clean checkout, including CI.
 *
 * What that failure looks like is the worst part of it. `useFaceLandmarker`
 * deliberately never throws: the model 404s, `isReady` stays false, and the
 * face screen shows a working camera that simply never captures, with nothing
 * on screen to say why. This was live on the deployed worker —
 * vision_wasm_internal.js served 200 while face_landmarker.task served 404.
 *
 * Downloaded, like opencv.js, for the same reason: no package ships it.
 */
const FACE_MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
/** The real file is ~3.7 MB; anything smaller is an error page. */
const FACE_MODEL_MIN_BYTES = 2 * 1024 * 1024;

/**
 * Blazeface — the face detector Amazon's Face Liveness component runs in the
 * browser before it will stream anything.
 *
 * `FaceLivenessDetectorCore` defaults to fetching this from tfhub.dev and its
 * WASM backend from cdn.jsdelivr.net. Both are blocked here on purpose:
 * `script-src` and `connect-src` are `'self'`, and a sign-in that depends on
 * two third-party CDNs staying reachable is a sign-in with two more ways to
 * fail — in countries where that reachability is not a given. Same reasoning
 * that put opencv.js and MediaPipe in this directory.
 *
 * One manifest and one weight shard; the manifest names the shard, so both are
 * fetched from the same directory.
 */
const BLAZEFACE_BASE =
    'https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1/model.json?tfjs-format=file';
/** ~64 KB of JSON; anything much smaller is an error page. */
const BLAZEFACE_MIN_BYTES = 20 * 1024;

// ── MediaPipe: copy from node_modules ───────────────────────────────────────
function syncMediapipe() {
    const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
    const dest = join(vendor, 'mediapipe');
    if (!existsSync(src)) {
        console.error(`[sync-vendor] missing ${src} — run npm install first.`);
        return false;
    }
    mkdirSync(dest, { recursive: true });
    let n = 0;
    let bytes = 0;
    for (const name of readdirSync(src)) {
        const from = join(src, name);
        if (!statSync(from).isFile()) continue;
        copyFileSync(from, join(dest, name));
        bytes += statSync(from).size;
        n++;
    }
    console.log(`[sync-vendor] mediapipe: ${n} files (${(bytes / 1048576).toFixed(1)} MB)`);
    return true;
}

// ── OpenCV: download (no npm package ships a browser build we can use) ──────
async function syncOpenCv() {
    const dest = join(vendor, 'opencv.js');
    if (existsSync(dest) && statSync(dest).size >= OPENCV_MIN_BYTES) {
        console.log('[sync-vendor] opencv.js: already present, skipping');
        return true;
    }
    mkdirSync(vendor, { recursive: true });
    console.log(`[sync-vendor] opencv.js: downloading from ${OPENCV_URL} …`);
    try {
        const res = await fetch(OPENCV_URL, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        // Guard against a proxy/captive-portal HTML page being written as JS —
        // it would fail confusingly at runtime instead of here.
        if (buf.length < OPENCV_MIN_BYTES) {
            throw new Error(`got ${buf.length} bytes, expected >= ${OPENCV_MIN_BYTES}`);
        }
        writeFileSync(dest, buf);
        console.log(`[sync-vendor] opencv.js: ${(buf.length / 1048576).toFixed(1)} MB`);
        return true;
    } catch (err) {
        console.error(`[sync-vendor] opencv.js FAILED: ${err.message}`);
        console.error('[sync-vendor] ID capture will not work until this succeeds.');
        return false;
    }
}

// ── The face landmarker model ───────────────────────────────────────────────
async function syncFaceModel() {
    const dest = join(vendor, 'mediapipe', 'face_landmarker.task');
    if (existsSync(dest) && statSync(dest).size >= FACE_MODEL_MIN_BYTES) {
        console.log('[sync-vendor] face_landmarker.task: already present, skipping');
        return true;
    }
    mkdirSync(join(vendor, 'mediapipe'), { recursive: true });
    console.log(`[sync-vendor] face_landmarker.task: downloading …`);
    try {
        const res = await fetch(FACE_MODEL_URL, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        // Same guard as opencv: a captive-portal HTML page written as a .task
        // would 404 nothing and fail silently at runtime instead of here.
        if (buf.length < FACE_MODEL_MIN_BYTES) {
            throw new Error(`got ${buf.length} bytes, expected >= ${FACE_MODEL_MIN_BYTES}`);
        }
        writeFileSync(dest, buf);
        console.log(
            `[sync-vendor] face_landmarker.task: ${(buf.length / 1048576).toFixed(1)} MB`,
        );
        return true;
    } catch (err) {
        console.error(`[sync-vendor] face_landmarker.task FAILED: ${err.message}`);
        console.error('[sync-vendor] The face check will open a camera and never capture.');
        return false;
    }
}

// ── TensorFlow WASM backend: copy from node_modules ─────────────────────────
// Same argument as MediaPipe's WASM — copied rather than downloaded so the
// served binaries cannot drift from the @tensorflow/tfjs-backend-wasm version
// the liveness component was built against.
function syncTfjsWasm() {
    const src = join(root, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist');
    const dest = join(vendor, 'tfjs-wasm');
    if (!existsSync(src)) {
        console.error(`[sync-vendor] missing ${src} — run npm install first.`);
        return false;
    }
    mkdirSync(dest, { recursive: true });
    let n = 0;
    let bytes = 0;
    for (const name of readdirSync(src)) {
        // Only the binaries the browser fetches at runtime. The package also
        // ships JS entry points, which the bundler handles itself.
        if (!name.endsWith('.wasm')) continue;
        const from = join(src, name);
        if (!statSync(from).isFile()) continue;
        copyFileSync(from, join(dest, name));
        bytes += statSync(from).size;
        n++;
    }
    console.log(`[sync-vendor] tfjs-wasm: ${n} files (${(bytes / 1048576).toFixed(1)} MB)`);
    return n > 0;
}

// ── Blazeface: download the manifest and the shard it names ─────────────────
async function syncBlazeface() {
    const dest = join(vendor, 'blazeface');
    const manifestPath = join(dest, 'model.json');
    if (existsSync(manifestPath) && statSync(manifestPath).size >= BLAZEFACE_MIN_BYTES) {
        console.log('[sync-vendor] blazeface: already present, skipping');
        return true;
    }
    mkdirSync(dest, { recursive: true });
    console.log('[sync-vendor] blazeface: downloading …');
    try {
        const res = await fetch(BLAZEFACE_BASE, { redirect: 'follow' });
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        const text = await res.text();
        if (text.length < BLAZEFACE_MIN_BYTES) {
            throw new Error(`manifest was ${text.length} bytes — probably an error page`);
        }
        writeFileSync(manifestPath, text);

        // The manifest names its own weight files, so follow it rather than
        // hardcoding a shard count that a future model revision could change.
        const manifest = JSON.parse(text);
        const shards = (manifest.weightsManifest ?? []).flatMap((w) => w.paths ?? []);
        if (shards.length === 0) throw new Error('manifest lists no weight files');

        const base = new URL(BLAZEFACE_BASE);
        for (const shard of shards) {
            const url = new URL(shard, base).toString();
            const bin = await fetch(url, { redirect: 'follow' });
            if (!bin.ok) throw new Error(`${shard} HTTP ${bin.status}`);
            writeFileSync(join(dest, shard), Buffer.from(await bin.arrayBuffer()));
        }
        console.log(`[sync-vendor] blazeface: model.json + ${shards.length} shard(s)`);
        return true;
    } catch (err) {
        console.error(`[sync-vendor] blazeface FAILED: ${err.message}`);
        console.error('[sync-vendor] The AWS liveness check will not start.');
        return false;
    }
}

// All of them, unconditionally — `a && await b` would skip a download whenever
// an earlier step failed, which is exactly the fresh-clone case.
const mediapipeOk = syncMediapipe();
const faceModelOk = await syncFaceModel();
const tfjsOk = syncTfjsWasm();
const blazefaceOk = await syncBlazeface();
const openCvOk = await syncOpenCv();
const ok = mediapipeOk && faceModelOk && tfjsOk && blazefaceOk && openCvOk;
// Do not fail the install: a developer who never touches KYC should not be
// blocked by a flaky download. The warning above is the signal.
if (!ok) console.warn('[sync-vendor] completed with errors (see above).');

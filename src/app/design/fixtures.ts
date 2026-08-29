import type { KycUser } from '@/features/kyc/context/KycSessionContext';
import type { IDDocument, LivenessResult } from '@/features/kyc/types/verification';
import type { System } from '@/features/system/schema';

/**
 * Stand-in data for the design gallery, and NOTHING ELSE.
 *
 * Several screens only take their real shape once they hold something: the
 * intro greets a name over a captured photo, the summary lists fields read off
 * an ID, the match screen puts the face beside the document. Rendered empty
 * they collapse to em-dashes and grey boxes — which is precisely the state you
 * cannot check a layout against.
 *
 * ── Why the images are inline SVG ───────────────────────────────────────────
 * They are generated here rather than committed as files so the gallery adds no
 * binary assets to a repo that would then carry them forever. They are also
 * obviously synthetic at a glance, which matters: a realistic-looking photo of a
 * realistic-looking ID sitting in `src/` is a thing that gets mistaken for real
 * data exactly once.
 *
 * `img-src 'self' data: blob:` in the CSP already permits data URIs, so nothing
 * had to be loosened to show them.
 */

const dataUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;

/** A portrait-shaped grey silhouette — stands in for the captured face. */
const FACE_IMAGE = dataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">
  <rect width="480" height="640" fill="#d8dde3"/>
  <circle cx="240" cy="250" r="96" fill="#aab3bd"/>
  <path d="M80 640c0-97 72-176 160-176s160 79 160 176z" fill="#aab3bd"/>
  <text x="240" y="612" font-family="sans-serif" font-size="24" fill="#6b7683"
        text-anchor="middle">sample face</text>
</svg>`);

/** The same silhouette cropped square — the photo printed on the ID. */
const ID_FACE_IMAGE = dataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <rect width="240" height="240" fill="#d8dde3"/>
  <circle cx="120" cy="95" r="52" fill="#aab3bd"/>
  <path d="M32 240c0-52 39-94 88-94s88 42 88 94z" fill="#aab3bd"/>
</svg>`);

/** An ID-card-shaped placeholder. `side` is printed on it so front/back differ. */
const idCard = (side: string) =>
    dataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="856" height="540" viewBox="0 0 856 540">
  <rect width="856" height="540" rx="32" fill="#eef1f5"/>
  <rect x="24" y="24" width="808" height="492" rx="20" fill="none" stroke="#b6bfc9" stroke-width="4"/>
  <rect x="64" y="96" width="200" height="240" rx="12" fill="#ccd3da"/>
  <rect x="300" y="112" width="420" height="24" rx="12" fill="#ccd3da"/>
  <rect x="300" y="168" width="340" height="24" rx="12" fill="#ccd3da"/>
  <rect x="300" y="224" width="380" height="24" rx="12" fill="#ccd3da"/>
  <rect x="300" y="280" width="260" height="24" rx="12" fill="#ccd3da"/>
  <rect x="64" y="392" width="656" height="24" rx="12" fill="#ccd3da"/>
  <text x="428" y="486" font-family="sans-serif" font-size="30" fill="#7c8794"
        text-anchor="middle">sample ID — ${side}</text>
</svg>`);

/** The captured live face, as the face step would have left it in context. */
export const FIXTURE_LIVENESS: LivenessResult = {
    faceImageData: FACE_IMAGE,
    isLive: true,
    // A constant, not Date.now(): this module is evaluated on the server and
    // again on the client, and a moving value there is a hydration mismatch.
    timestamp: 0,
};

/** A scanned document, as the ID steps would have left it in context. */
export const FIXTURE_ID_DOCUMENT: IDDocument = {
    frontImageData: idCard('front'),
    backImageData: idCard('back'),
    idFaceImageData: ID_FACE_IMAGE,
    idType: 'national_id',
    idName: 'National ID Card',
    country: 'Türkiye',
    name: 'Sample Preview Name',
    firstName: 'Sample',
    lastName: 'Preview Name',
    nationalNumber: '12345678901',
    documentNumber: '12345678901',
    birthday: '1990-01-01',
    expiryDate: '2032-01-01',
};

/** Signed-in admin, for the screens that greet one by name. */
export const FIXTURE_KYC_USER: KycUser = {
    id: 'design-preview',
    firstName: 'Sample',
    lastName: 'Preview Name',
};

/**
 * The systems registry, which currently has no backend to come from — the
 * registry lived in the deleted `root-backend`, so `listSystems()` throws
 * rather than returning rows. Shaped to `systemSchema`.
 */
export const FIXTURE_SYSTEMS: System[] = [
    {
        id: 'rdb',
        code: 'rdb',
        name: 'Ramaaz Digital Banking',
        description: 'Payment Services Provider',
    },
    {
        id: 'trydos',
        code: 'trydos',
        name: 'Try Direct Online Shopping',
        description: 'E-commerce Marketplace',
    },
];

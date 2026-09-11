/**
 * The face captured earlier in this sign-in, fetched back as base64.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The captured frame lives in React state and dies with the page. A refresh on
 * the ID step therefore left `FaceMatchScreen` unable to compare anything —
 * `hasLiveFace: false` — on a screen that was visibly SHOWING the face, because
 * the picture came from the stored copy while the comparison still demanded the
 * lost bytes.
 *
 * This fetches those bytes back, so a reload costs nothing.
 *
 * ── Why it lives in services/ and not beside the screen ─────────────────────
 * `fetch` is banned in `components/**` (AGENTS.md §2, enforced by eslint): UI
 * calls a Server Action or a feature api module, never the network directly.
 * This is that module.
 *
 * ── What it returns ─────────────────────────────────────────────────────────
 * A `data:` URL, because the compare and enrol endpoints take base64 — a URL
 * posted as `selfie` is not an image.
 *
 * Same origin, so no CORS and nothing for the CSP to refuse:
 * `/api/face-capture` reads the backend's URL from the challenge cookie
 * server-side and streams the bytes. It takes no parameters, so this cannot ask
 * for anything but the face belonging to the caller's own sign-in.
 */
export async function fetchStoredFace(): Promise<string> {
    const res = await fetch('/api/face-capture', { cache: 'no-store' });
    if (!res.ok) throw new Error(`face-capture: ${res.status}`);

    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

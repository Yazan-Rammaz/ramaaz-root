import { proxyImage } from "@/lib/api/proxy-image";
import { readChallenge } from "@/lib/auth/challenge";
import { getRefreshToken, readLockHolder } from "@/lib/auth/cookies";
import { getSession, sessionFromCookie } from "@/lib/auth/session";

/**
 * The admin's own photo, for the PIN and lock screens — served from our origin
 * because the backend's `photo_url` cannot be loaded by the browser (see
 * `proxyImage`).
 *
 * ── Where the URL comes from ────────────────────────────────────────────────
 * The backend hands out a fresh signed URL (~15 min) on every response that
 * carries one, so this asks whichever source is current for the caller:
 *
 *   mid sign-in       the challenge cookie — `photo_url` from PASS_CODE_REQUIRED
 *   signed in         `GET /v1/me`, through `getSession()` — a new signature on
 *                     every call, so the dashboard lock never shows a dead one
 *   locked (/unlock)  the `photo_url` on the `401 PASS_CODE_REQUIRED` refusal
 *                     that raised the lock — freshly signed, kept by middleware
 *                     in `root_lock` (console-api.md §3). Only when there is
 *                     none (a lock raised another way, or left open past 14
 *                     minutes) the sign-in snapshot, usually expired by then:
 *                     a 404, and the screen shows the avatar glyph.
 *
 * A challenge in progress wins outright, even without a photo: whoever is
 * signing in is not necessarily whoever this browser's older session belonged
 * to, and showing that person's face would be worse than showing none.
 *
 * Takes no parameters, like `/api/face-capture`, so it can only ever return the
 * picture belonging to the caller's own cookies.
 */

// A per-request read of httpOnly cookies — never prerendered, never cached.
export const dynamic = "force-dynamic";

/** The URL, and which source answered — the source is only for the log line. */
async function photoUrl(): Promise<{ url?: string; source: string }> {
  const challenge = await readChallenge();
  if (challenge.challengeToken) return { url: challenge.photoUrl, source: "challenge" };

  const session = await getSession();
  if (session) return { url: session.photoUrl, source: "session (/v1/me)" };

  // No access token. Only a refresh token makes the snapshot this browser's
  // live (locked) session rather than a leftover.
  if (!(await getRefreshToken())) return { source: "none (signed out)" };
  // The refusal that put up the lock carries a freshly signed photo.
  const lock = await readLockHolder();
  if (lock?.photoUrl) return { url: lock.photoUrl, source: "lock refusal (locked)" };
  return { url: (await sessionFromCookie())?.photoUrl, source: "sign-in snapshot (locked)" };
}

export async function GET() {
  const { url, source } = await photoUrl();
  // A miss with no URL used to be silent, which left a 404 with no way to tell
  // WHICH source came back empty. Upstream failures log in proxyImage.
  if (!url) console.warn(`[admin-photo] no photo_url from ${source}`);
  return proxyImage(url, "admin-photo");
}

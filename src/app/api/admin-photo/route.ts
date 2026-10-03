import { proxyImage } from "@/lib/api/proxy-image";
import { readChallenge } from "@/lib/auth/challenge";
import { getRefreshToken } from "@/lib/auth/cookies";
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
 *   locked (/unlock)  the user snapshot from sign-in. There is no access token
 *                     to ask `/v1/me` with, so this URL is as old as the
 *                     sign-in and is usually expired by now — a 404, and the
 *                     screen shows the avatar glyph. Fixing that needs the
 *                     backend to put the user on the `401 PASS_CODE_REQUIRED`
 *                     refusal (offered in frontend-admin-name-and-photo.md §4).
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

async function photoUrl(): Promise<string | undefined> {
  const challenge = await readChallenge();
  if (challenge.challengeToken) return challenge.photoUrl;

  const session = await getSession();
  if (session) return session.photoUrl;

  // No access token. Only a refresh token makes the snapshot this browser's
  // live (locked) session rather than a leftover.
  if (!(await getRefreshToken())) return undefined;
  return (await sessionFromCookie())?.photoUrl;
}

export async function GET() {
  return proxyImage(await photoUrl(), "admin-photo");
}

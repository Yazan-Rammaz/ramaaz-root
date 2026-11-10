import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { safeNextPath } from "@/features/passcode/schema";
import { clearChallenge, setSessionEnded } from "@/lib/auth/challenge";
import {
  clearAuthCookies,
  dropAccessToken,
  getAccessToken,
  tokenFingerprint,
} from "@/lib/auth/cookies";
import { ERROR_CODES } from "@/lib/auth/endpoints";
import { isProd } from "@/lib/env";

/**
 * Where a page render lands after the backend answered 401 — sent here by
 * `requireSession` with the error's `code`, the fingerprint `t` of the access
 * token the failed call carried, and `next`, where the render was headed.
 *
 * ── Why a route, and not the render itself ──────────────────────────────────
 * Every answer but one has to write cookies, and a Server Component cannot.
 *
 * ── What each 401 means (token-handling §3 and §5) ──────────────────────────
 *   token rotated since   the call raced a refresh — the PIN unlock rotates the
 *                         pair while the page may still be loading with the old
 *                         access token, which the backend kills at once.
 *                         Retry with the current one: back to `next`.
 *   TOKEN_EXPIRED         drop the access cookie and go back: middleware
 *                         refreshes (single-flight). Once — a second one inside
 *                         a minute is a loop, and ends the session instead.
 *   PASS_CODE_REQUIRED    drop the access cookie, ask for the PIN at /unlock.
 *   anything else         UNAUTHENTICATED (link revoked, account suspended,
 *                         "Sign in again to set your PIN"), TOKEN_REUSED,
 *                         MFA_REQUIRED: over. Clear everything, send them to
 *                         their link — /no-access says "your session ended".
 *
 * The fingerprint is also what keeps this from being a sign-out link: without
 * the current token's fingerprint, which never leaves the server, a crafted
 * URL can only bounce to `next`.
 */

// A per-request read of httpOnly cookies — never prerendered, never cached.
export const dynamic = "force-dynamic";

/** "One TOKEN_EXPIRED retry already happened" — the loop guard above. */
const RETRIED_COOKIE = "root_recovered";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const next = safeNextPath(params.get("next"));
  const failedWith = params.get("t");

  const current = await getAccessToken();
  // No longer the token that failed (or none at all — middleware refreshes).
  if (!current || !failedWith || (await tokenFingerprint(current)) !== failedWith) {
    redirect(next);
  }

  const store = await cookies();
  switch (params.get("code")) {
    case ERROR_CODES.tokenExpired:
      if (store.has(RETRIED_COOKIE)) break;
      store.set(RETRIED_COOKIE, "1", {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 60,
      });
      await dropAccessToken();
      redirect(next);
    case ERROR_CODES.passCodeRequired:
      await dropAccessToken();
      redirect(`/unlock?${new URLSearchParams({ next })}`);
  }

  console.warn(`[auth] ${params.get("code") ?? "401"} on the current token — session cleared`);
  await clearAuthCookies();
  await clearChallenge();
  await setSessionEnded();
  redirect("/no-access");
}

import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, type SessionUser } from "./session";

/**
 * Where a signed-in admin belongs.
 *
 * NOT always /dashboard: an admin who still owes a face check or ID enrolment
 * has to finish that first. Routing them straight to the dashboard would let
 * KYC be skipped by typing a URL.
 */
export function sessionHome(session: SessionUser): string {
  return session.requiresFaceVerification || session.requiresKyc
    ? "/login/identity"
    : "/dashboard";
}

/**
 * Bounce an already-signed-in admin off the login screens.
 *
 * Call from the sign-in steps (/login, /login/password, /login/verify,
 * /login/set-passcode). NOT from /login/identity — that one *requires* a
 * session, so guarding it here would redirect it to itself.
 */
export async function redirectIfAuthenticated(): Promise<void> {
  const session = await getSession();
  if (session) redirect(sessionHome(session));
}

/**
 * Refreshing a half-finished sign-in starts it over.
 *
 * Detected from `Sec-Fetch-Dest`, which the browser sets to "document" for a
 * top-level navigation — a refresh, a typed URL, a new tab — and to "empty"
 * for the RSC fetch behind a client-side navigation. So arriving here from the
 * previous step passes through untouched, while a reload clears the flow.
 *
 * The obvious client-side alternative does NOT work: the Navigation Timing API
 * describes the DOCUMENT, not the route change, so its `reload` verdict stays
 * true for the document's whole life. Reading it after soft-navigating from
 * /login sent the admin straight back to /login, and round again.
 *
 * Only for steps BEFORE an OTP is sent: discarding a live challenge costs a
 * real WhatsApp message and one of three resends.
 *
 * It redirects without clearing the flow cookie, because a Server Component
 * render may not mutate cookies — only Server Actions and Route Handlers may,
 * and calling clearLoginFlow() here threw a 500. Clearing is unnecessary
 * anyway: the cookie is httpOnly, expires in MAX_AGE, and the next attempt
 * overwrites it. /login reads `rdb_pc`, not the flow, so a stale entry cannot
 * resurrect a half-finished sign-in.
 */
export async function resetFlowOnFullLoad(): Promise<void> {
  const dest = (await headers()).get("sec-fetch-dest");
  if (dest !== "document") return;

  redirect("/login");
}

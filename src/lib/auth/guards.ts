import "server-only";
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

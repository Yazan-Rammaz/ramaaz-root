import "server-only";
import { redirect } from "next/navigation";
import { getSession, type SessionUser } from "./session";

/**
 * Where a signed-in admin belongs.
 *
 * Always the dashboard now. It used to branch on `requires_face_verification` /
 * `requires_kyc`, because identity was proven AFTER sign-in and could still be
 * outstanding while a session existed. In this protocol the face and ID steps
 * run INSIDE the challenge, before any token is issued — so holding a session
 * already means they were passed, and there is nothing left to route around.
 */
export function sessionHome(_session: SessionUser): string {
  return "/dashboard";
}

/**
 * Bounce an already-signed-in admin off the sign-in screens.
 *
 * Call from every step screen. Harmless where the challenge has already ended
 * — a completed sign-in has no challenge left, so the only way to be on one of
 * these pages holding a session is to have navigated back to it.
 */
export async function redirectIfAuthenticated(): Promise<void> {
  const session = await getSession();
  if (session) redirect(sessionHome(session));
}

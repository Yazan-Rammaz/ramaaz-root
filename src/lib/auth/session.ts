import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getAccessToken, readSessionUser } from "@/lib/auth/cookies";
import { wireUserSchema, type WireUser } from "@/lib/auth/endpoints";
import { hasRole, type Role } from "@/lib/auth/rbac";

export type SessionUser = {
  id: string;
  /** The backend's `full_name`, verbatim. */
  name: string;
  /** Derived by splitting `name` — the API has no separate name fields. */
  firstName: string;
  lastName: string;
  role: Role;
  /** ISO country code for country managers/agents, if applicable. */
  countryCode?: string;
  /** Unmasked phone from the session payload. */
  phone?: string;
  privateCode?: string;
  /**
   * ── Both are vestigial ──────────────────────────────────────────────────
   * They described the previous protocol, where identity was proven AFTER
   * sign-in and a session could exist with the checks still outstanding. The
   * face and ID steps now run inside the challenge, before a token exists, so
   * a session means they are already done and `stage` is what reports them
   * while they are not.
   *
   * Kept, defaulting to false, only because the KYC screens still read them
   * while they are ported onto the challenge (phase 2). Do not add new
   * branches on these.
   */
  requiresFaceVerification: boolean;
  requiresKyc: boolean;
};

/**
 * Wire user → SessionUser.
 *
 * Two things the API does not give us:
 *
 *  - **No role.** `is_root` is the only privilege signal, so root maps to
 *    super_admin and everyone else falls back to the LEAST privileged role.
 *    Guessing high would show controls the backend then refuses; guessing low
 *    only under-renders, and frontend RBAC is render-only anyway (AGENTS.md §3).
 *    A real role field would replace this.
 *  - **No split name.** `full_name` is one string; the KYC screens greet people
 *    by first name, so it splits on the first space and the remainder is the
 *    surname ("Root Administrator" → "Root" / "Administrator"). A single-word
 *    name yields an empty surname rather than duplicating it.
 */
export function toSessionUser(u: WireUser): SessionUser {
  const trimmed = u.full_name.trim();
  const gap = trimmed.indexOf(" ");
  return {
    id: u.id,
    name: trimmed,
    firstName: gap === -1 ? trimmed : trimmed.slice(0, gap),
    lastName: gap === -1 ? "" : trimmed.slice(gap + 1).trim(),
    role: u.is_root ? "super_admin" : "agent",
    phone: u.phone,
    privateCode: u.private_code,
    requiresFaceVerification: u.requires_face_verification ?? false,
    requiresKyc: u.requires_kyc ?? false,
  };
}

/**
 * Who is signed in — read from the session cookie, NOT from the backend.
 *
 * ⚠️ `GET /v1/me` is gone. It was the authoritative read, and while it was
 * broken this function answered `null` for everybody: the request failed, the
 * catch below logged it and returned null, and every protected page redirected
 * to /login. A signed-in administrator could not reach the dashboard at all.
 *
 * So the user is taken from the cookie written at sign-in, where the COMPLETED
 * response handed us the whole record. `cache()` still dedupes across a render
 * pass, which now costs nothing rather than saving a round trip.
 *
 * ── What this gives up, stated plainly ──────────────────────────────────────
 * It no longer asks the backend whether the session is still good. The gate is
 * "does this browser hold an access cookie", not "does the server still accept
 * it" — so a session revoked server-side keeps rendering the shell until its
 * token expires or a real request answers 401.
 *
 * That is narrower than it sounds, and was already the design: frontend RBAC
 * decides rendering only, and NestJS enforces every real rule (AGENTS.md §3).
 * Every call that touches data still carries the bearer and still gets a 401.
 * What a stale cookie buys is an empty dashboard frame.
 *
 * The access cookie is the signal because middleware maintains it: it refreshes
 * it silently while the refresh token is good, and DELETES BOTH the moment a
 * refresh is refused. A dead session therefore stops rendering on the next
 * request rather than lingering.
 *
 * Restore the endpoint and this becomes one call again — `toSessionUser` and
 * `meResponseSchema` are both still here.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  // The token is what says "signed in"; the snapshot only says who. Without it
  // there is no session, whatever the snapshot claims.
  if (!(await getAccessToken())) return null;

  const user = await readSessionUser<WireUser>();
  if (!user) return null;

  try {
    return toSessionUser(wireUserSchema.parse(user));
  } catch (error) {
    // Our own cookie failed our own schema — it predates a shape change, or was
    // tampered with. Either way it is not a session.
    console.warn("[auth] session cookie did not parse:", error);
    return null;
  }
});

/** Use at the top of any protected Server Component / layout. */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Server-side role gate. UI gating only — NestJS still enforces the real rule. */
export async function requireRole(allowed: Role[]): Promise<SessionUser> {
  const session = await requireSession();
  if (!hasRole(session.role, allowed)) redirect("/forbidden");
  return session;
}

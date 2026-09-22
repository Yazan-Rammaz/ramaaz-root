import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api/server";
import { getAccessToken, readSessionUser } from "@/lib/auth/cookies";
import {
  AUTH_PATHS,
  meResponseSchema,
  wireUserSchema,
  type WireUser,
} from "@/lib/auth/endpoints";
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
 * Who is signed in — asked of the backend, with the cookie as a fallback.
 *
 * ⚠️ THIS ENDPOINT HAS BEEN BROKEN BEFORE, and the failure was severe: `/v1/me`
 * returned a sparse projection, `wireUserSchema` rejected it, this function
 * answered `null` for everybody, and every protected page redirected to /login.
 * A signed-in administrator could not reach the dashboard at all. The backend
 * fixed it on 2026-09-22 — it now returns the account as stored, the same shape
 * as `tokens.user` at sign-in. `cache()` dedupes it across a render pass.
 *
 * ── Why the cookie is still read ────────────────────────────────────────────
 * Not as a second source of truth, and never in preference to the backend. The
 * rule is exactly:
 *
 *   401 from the backend   → null. The session really is over — revoked link,
 *                            signed out elsewhere, expired chain.
 *   any other failure      → fall back to the cookie snapshot. A timeout, a
 *                            5xx, or no backend configured at all says nothing
 *                            about whether this person is signed in, and
 *                            bouncing them to /login over a blip is a worse
 *                            answer than rendering a shell from what the
 *                            COMPLETED response already told us.
 *
 * The snapshot is written by `applyStage` at sign-in and is never newer than
 * the backend, so the only thing it can get wrong is staleness — and the access
 * cookie bounds that: middleware refreshes it while the refresh token is good
 * and deletes both the moment a refresh is genuinely refused.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not authorise anything. Frontend RBAC decides rendering only and the
 * backend enforces every real rule (AGENTS.md §3) — every call that touches
 * data carries the bearer and gets its own 401.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  // The token is what says "signed in". Without it there is nothing to ask
  // with, and the snapshot alone is not a session.
  if (!(await getAccessToken())) return null;

  try {
    const raw = await api.get<unknown>(AUTH_PATHS.me);
    return toSessionUser(meResponseSchema.parse(raw).user);
  } catch (error) {
    // The session is over. Say so — this is the one failure that means it.
    if (error instanceof ApiError && error.status === 401) return null;

    console.warn("[auth] /v1/me unavailable, falling back to session cookie:", error);
    return sessionFromCookie();
  }
});

/**
 * The snapshot written at sign-in. Used only when the backend could not be
 * asked — see `getSession`.
 */
async function sessionFromCookie(): Promise<SessionUser | null> {
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
}

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

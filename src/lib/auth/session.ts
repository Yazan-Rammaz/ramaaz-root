import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { api, ApiError, isBackendConfigured } from "@/lib/api/server";
import { AUTH_PATHS, meResponseSchema, type WireUser } from "@/lib/auth/endpoints";
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
  /** Must pass a live face check against the stored photo before the dashboard. */
  requiresFaceVerification: boolean;
  /** Has never completed ID enrolment — drives the full KYC flow. */
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
    requiresFaceVerification: u.requires_face_verification,
    requiresKyc: u.requires_kyc,
  };
}

/**
 * The authoritative session — the backend's `/auth/me`. `cache()` dedupes it
 * across a single render pass. Returns null when unauthenticated.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  // No backend wired yet — nobody can be signed in, so don't throw-and-catch
  // once per request just to reach the same answer.
  if (!isBackendConfigured()) return null;

  try {
    // Confirmed against staging: `{ user, projects }`, where `user` is a
    // SPARSE version of the sign-in payload — see wireUserSchema.
    const raw = await api.get<unknown>(AUTH_PATHS.me);
    return toSessionUser(meResponseSchema.parse(raw).user);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return null;
    }
    // Anything else is NOT a "you're signed out" answer — the backend is
    // unreachable, or NEST_API_URL is malformed. Still return null so protected
    // pages fall through to /login rather than crashing the render, but say so
    // loudly: silently redirecting forever is the worst way to learn that a
    // base URL has a typo in it.
    console.error(
      "[auth] /auth/me failed — treating as signed out. Check NEST_API_URL:",
      error instanceof Error ? error.message : error,
    );
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

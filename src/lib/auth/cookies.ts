import "server-only";
import { cookies } from "next/headers";
import { isProd } from "@/lib/env";

/**
 * httpOnly auth cookies. Tokens NEVER reach JavaScript — this is the core of the
 * BFF security model (immune to XSS token theft). Only Server Actions, Route
 * Handlers and middleware may touch these.
 *
 * ── Why there are only two ──────────────────────────────────────────────────
 * The previous protocol also remembered the admin's private code (`root_pc`)
 * and a display name (`root_who`), so a returning admin could unlock with just
 * a PIN. Both are gone with the PIN:
 *
 *  - the private code is no longer an identifier at all. It is a one-time code
 *    pulled over WhatsApp, valid for 50 seconds — there is nothing to remember.
 *  - the ACCESS LINK is the identity now, and the trusted device is stored
 *    backend-side, so this app persists nothing about who signed in last.
 *
 * The in-progress sign-in lives in its own cookie — see lib/auth/challenge.ts.
 */
const ACCESS = "root_at";
const REFRESH = "root_rt";

const base = {
  httpOnly: true,
  secure: isProd, // allow http on localhost during dev
  sameSite: "lax" as const, // lax: survives top-level nav, blocks cross-site POST
  path: "/",
};

export async function setAuthCookies(opts: {
  accessToken: string;
  refreshToken: string;
  /** seconds */
  accessMaxAge: number;
  /** seconds */
  refreshMaxAge: number;
}) {
  const store = await cookies();
  store.set(ACCESS, opts.accessToken, { ...base, maxAge: opts.accessMaxAge });
  store.set(REFRESH, opts.refreshToken, { ...base, maxAge: opts.refreshMaxAge });
}

export async function clearAuthCookies() {
  const store = await cookies();
  store.delete(ACCESS);
  store.delete(REFRESH);
}

export async function getAccessToken() {
  return (await cookies()).get(ACCESS)?.value ?? null;
}

export async function getRefreshToken() {
  return (await cookies()).get(REFRESH)?.value ?? null;
}

export const AUTH_COOKIE_NAMES = { ACCESS, REFRESH } as const;

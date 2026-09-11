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
/**
 * Who is signed in, as the backend described them at sign-in.
 *
 * ⚠️ This exists because `GET /v1/me` DOES NOT WORK. That endpoint was the
 * authoritative session read, and with it gone `getSession()` had no way to
 * answer "who is this" — so every protected page decided nobody was signed in
 * and bounced to /login.
 *
 * The COMPLETED response already carries the whole user (`tokens.user`), so it
 * is kept here rather than re-fetched. Same protections as the tokens beside
 * it: httpOnly, Secure in production, SameSite=lax, and cleared together.
 *
 * NOT a credential and not a permission. It decides what a screen RENDERS and
 * nothing else — every real rule is enforced by the backend on a request that
 * carries the access token, and a forged cookie would get a 401 there. That was
 * already the rule (AGENTS.md §3: "Frontend RBAC is for rendering only"), which
 * is what makes this substitution acceptable rather than merely convenient.
 */
const USER = "root_user";

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

/**
 * Remember the signed-in user. See the note on USER above.
 *
 * Given the REFRESH token's lifetime, not the access token's: the access cookie
 * expires every 15 minutes and is replaced by silent refresh, and a user
 * snapshot that vanished with it would log the administrator out of the UI
 * while their session was still perfectly alive.
 */
export async function setSessionUser(user: unknown, maxAge: number) {
  (await cookies()).set(USER, JSON.stringify(user), { ...base, maxAge });
}

export async function readSessionUser<T>(): Promise<T | null> {
  const raw = (await cookies()).get(USER)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function clearAuthCookies() {
  const store = await cookies();
  store.delete(ACCESS);
  store.delete(REFRESH);
  store.delete(USER);
}

export async function getAccessToken() {
  return (await cookies()).get(ACCESS)?.value ?? null;
}

export async function getRefreshToken() {
  return (await cookies()).get(REFRESH)?.value ?? null;
}

export const AUTH_COOKIE_NAMES = { ACCESS, REFRESH, USER } as const;

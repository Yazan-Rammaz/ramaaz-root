import "server-only";
import { cookies } from "next/headers";
import { isProd } from "@/lib/env";

/**
 * httpOnly auth cookies. Tokens NEVER reach JavaScript — this is the core of the
 * BFF security model (immune to XSS token theft). Only Server Actions, Route
 * Handlers and middleware may touch these.
 */
const ACCESS = "root_at";
const REFRESH = "root_rt";
/**
 * The signed-in admin's private code.
 *
 * Needed because the passcode LOCK SCREEN (re-prove yourself on a live session)
 * unlocks via POST /v1/auth/login, which requires `private_code` + `secret`
 * together — and by then the login-flow cookie has been cleared. GET /v1/me
 * cannot supply it: it returns `private_code` as an empty string.
 *
 * Same protection as the tokens beside it — httpOnly, so it never reaches
 * client JS — and cleared with them on sign-out.
 */
const PRIVATE_CODE = "root_pc";
/**
 * Display-only identity for the returning-user passcode screen: who this
 * device signed in as last time.
 *
 * Nothing about the admin is knowable before sign-in — /v1/auth/login is the
 * first call and it needs the passcode this screen is collecting — so without
 * remembering it the screen greets a blank space. Carries no credential.
 */
const IDENTITY = "root_who";

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

/** Store the private code for the lock screen. Lives as long as the session. */
export async function setPrivateCodeCookie(code: string, maxAge: number) {
  (await cookies()).set(PRIVATE_CODE, code, { ...base, maxAge });
}

export async function getPrivateCode() {
  return (await cookies()).get(PRIVATE_CODE)?.value ?? null;
}

export type RememberedIdentity = { name: string; role: string };

export async function setIdentityCookie(
  identity: RememberedIdentity,
  maxAge: number,
) {
  (await cookies()).set(IDENTITY, JSON.stringify(identity), { ...base, maxAge });
}

export async function getIdentity(): Promise<RememberedIdentity | null> {
  const raw = (await cookies()).get(IDENTITY)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RememberedIdentity;
  } catch {
    return null;
  }
}

/**
 * Forget which admin this device belongs to, without touching the session.
 *
 * The escape hatch behind "Use a different code": /login goes straight to the
 * passcode whenever a private code is remembered, so a stale one (the admin
 * was deleted, or somebody else needs to sign in) left no way back to the
 * private-code field except clearing cookies by hand.
 */
export async function clearRememberedIdentity() {
  const store = await cookies();
  store.delete(PRIVATE_CODE);
  store.delete(IDENTITY);
}

export async function clearAuthCookies() {
  const store = await cookies();
  store.delete(ACCESS);
  store.delete(REFRESH);
  store.delete(PRIVATE_CODE);
  store.delete(IDENTITY);
}

export async function getAccessToken() {
  return (await cookies()).get(ACCESS)?.value ?? null;
}

export async function getRefreshToken() {
  return (await cookies()).get(REFRESH)?.value ?? null;
}

export const AUTH_COOKIE_NAMES = { ACCESS, REFRESH, PRIVATE_CODE } as const;

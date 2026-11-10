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
/**
 * How many digits this account's PIN has — `pass_code_length` from the sign-in
 * step, kept because the two screens that ask for the PIN AFTER sign-in (the
 * dashboard lock and /unlock) are never told it again: `401 PASS_CODE_REQUIRED`
 * on refresh carries no length. Not a secret; httpOnly only because every
 * other auth cookie is, and the server reads it anyway.
 */
const PIN_LENGTH = "root_pin_len";
/**
 * "The server said a passkey is bound to this link" — a HINT, not a fact.
 *
 * Decides one thing: whether the lock screens lead with the passkey or offer
 * to set one up. Written from the three places the server tells us —
 * `device_available` on the PIN step, `details.device_available` on a locked
 * refresh, and a successful `/v1/me/device`. Wrong in either direction costs
 * nothing: a stale "bound" fails its options call and the PIN is still there;
 * a stale "not bound" offers setup and the server answers 409.
 */
const DEVICE = "root_device";
/**
 * "The server said a NEW passkey may be added here" — `device_enrol_available`,
 * the hint that decides whether the lock screens offer Add device
 * (console-api.md §3: it and `device_available` "say which buttons to offer").
 *
 * Three states, because the server does not always say: "1" offer it, "0"
 * don't, absent = never told, which offers it as before (the backend still
 * refuses a setup it does not allow). Written from the sign-in PIN step and
 * from every `401 PASS_CODE_REQUIRED` refusal on refresh.
 */
const DEVICE_ENROL = "root_device_enrol";
/**
 * Whose lock /unlock is showing — `{ name, photoUrl }` from the
 * `401 PASS_CODE_REQUIRED` refusal, written by middleware when it sends a page
 * there (console-api.md §3, "The lock screen"). That screen has no access token
 * to ask `/v1/me` with, so without this its photo was the sign-in snapshot's,
 * long expired.
 *
 * Short-lived on purpose: `photo_url` is presigned for ~15 minutes and the
 * backend says not to store it, so this only carries it from the redirect to
 * the two requests that show it (/unlock and /api/admin-photo), and dies
 * before the signature does. Removed as soon as a new pair is stored.
 */
const LOCK = "root_lock";
/** A minute inside the photo's ~15-minute signature. */
export const LOCK_MAX_AGE = 14 * 60;

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
  // A new pair means the session is unlocked — the lock's details are stale.
  store.delete(LOCK);
}

/** The lock's holder from the refusal, or null when no lock put it there. */
export async function readLockHolder(): Promise<{ name?: string; photoUrl?: string } | null> {
  const raw = (await cookies()).get(LOCK)?.value;
  if (!raw) return null;
  try {
    const { name, photoUrl } = JSON.parse(raw) as { name?: unknown; photoUrl?: unknown };
    return {
      name: typeof name === "string" ? name : undefined,
      photoUrl: typeof photoUrl === "string" ? photoUrl : undefined,
    };
  } catch {
    return null;
  }
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

/** Same lifetime as the user snapshot, for the same reason. */
export async function setPinLength(length: number, maxAge: number) {
  (await cookies()).set(PIN_LENGTH, String(length), { ...base, maxAge });
}

/** Undefined when sign-in never said — callers fall back to their default. */
export async function readPinLength(): Promise<number | undefined> {
  const n = Number((await cookies()).get(PIN_LENGTH)?.value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function setDeviceHint(bound: boolean, maxAge: number) {
  const store = await cookies();
  if (bound) store.set(DEVICE, "1", { ...base, maxAge });
  else store.delete(DEVICE);
}

/** Undefined (the server did not say) leaves the hint as it was. */
export async function setEnrolHint(available: boolean | undefined, maxAge: number) {
  if (available === undefined) return;
  (await cookies()).set(DEVICE_ENROL, available ? "1" : "0", { ...base, maxAge });
}

/** False only when the server last said no — see DEVICE_ENROL. */
export async function readEnrolHint(): Promise<boolean> {
  return (await cookies()).get(DEVICE_ENROL)?.value !== "0";
}

export async function readDeviceHint(): Promise<boolean> {
  return (await cookies()).get(DEVICE)?.value === "1";
}

export async function clearAuthCookies() {
  const store = await cookies();
  store.delete(ACCESS);
  store.delete(REFRESH);
  store.delete(USER);
  store.delete(PIN_LENGTH);
  store.delete(DEVICE);
  store.delete(DEVICE_ENROL);
  store.delete(LOCK);
}

/**
 * Drop the access token only, keeping the refresh token — so the next request's
 * middleware refreshes (or, while the PIN is wanted, /unlock asks for it).
 */
export async function dropAccessToken() {
  (await cookies()).delete(ACCESS);
}

/**
 * A short, one-way name for an access token — enough to tell two tokens apart,
 * useless for anything else. What travels in /api/auth/recover's query string
 * instead of the token.
 */
export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function getAccessToken() {
  return (await cookies()).get(ACCESS)?.value ?? null;
}

export async function getRefreshToken() {
  return (await cookies()).get(REFRESH)?.value ?? null;
}

export const AUTH_COOKIE_NAMES = { ACCESS, REFRESH, USER, PIN_LENGTH, DEVICE, DEVICE_ENROL, LOCK } as const;

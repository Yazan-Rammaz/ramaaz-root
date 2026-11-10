import "server-only";
import { cookies, headers } from "next/headers";
import { env, isProd } from "@/lib/env";
import { cfEnv } from "@/lib/cf-env";
import {
  clearAuthCookies,
  getAccessToken,
  getRefreshToken,
  setAuthCookies,
  tokenFingerprint,
} from "@/lib/auth/cookies";
import { setSessionEnded } from "@/lib/auth/challenge";
import { apiErrorSchema, ERROR_CODES } from "@/lib/auth/endpoints";
import { refreshTokens } from "@/lib/auth/refresh";
import { edgeHeaders, FALLBACK_USER_AGENT } from "./edge";

/**
 * THE single way to call the NestJS API. Server-only.
 *
 * Rules (lint-enforced — see eslint boundaries + no-restricted-imports):
 *   - Client Components must NOT import this and must NOT call NestJS directly.
 *   - All browser-originated data goes through a Server Action or Route Handler
 *     that uses this client. The browser only ever talks to our own origin.
 *
 * Token refresh is handled centrally in middleware.ts (it can set cookies);
 * this client just attaches the current access token and surfaces 401s.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    /**
     * `Retry-After`, in seconds, when the response carried one.
     *
     * Kept on the error because the response object does not survive this
     * function, and the header is the only place the delay is guaranteed to
     * be: a 429 from the backend also puts it in
     * `error.details.retry_after_seconds`, but one raised by an edge or a proxy
     * in front of it may have no JSON body at all. `retryAfterSeconds()` in
     * `lib/auth/errors.ts` prefers this and falls back to the body.
     */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /**
   * On a 401: a fingerprint of the access token the request was SENT with
   * (`tokenFingerprint`), never the token itself. `/api/auth/recover` compares
   * it with the one the browser holds now, to tell a session that ended from a
   * request that merely raced a rotation (token-handling §3).
   */
  sentWith?: string;
}

/**
 * `NEST_API_URL` is unset — which, everywhere the app actually runs, it is not.
 * It is set in `wrangler.jsonc`, `.env.local` and `.dev.vars`; CI is the one
 * environment that deliberately omits it (AGENTS.md §8).
 *
 * Without it every call would fail somewhere deep in fetch with a DNS error.
 * One explicit 503 instead: screens still render, and anything that actually
 * needs data says plainly why it can't have any. `getSession()` reads this as
 * "unauthenticated", so the app degrades to the login screen rather than
 * crashing the render.
 */
/**
 * Is a backend wired at all? Lets callers that treat "no backend" as a normal
 * state (`getSession`) skip the call instead of throwing and catching on every
 * request — which Next logs, burying real errors in noise.
 *
 * Reads `process.env` directly rather than the validated `env`, because this
 * must NEVER throw: `env` validates on first access and a malformed
 * `NEST_API_URL` (e.g. a host with no scheme) would blow up in callers that
 * only wanted a yes/no. Presence is all that's asked here — validity is still
 * enforced at the actual call, inside the caller's error handling.
 */
export function isBackendConfigured(): boolean {
  return Boolean(process.env.NEST_API_URL);
}

export class BackendNotConfiguredError extends ApiError {
  constructor() {
    super(
      503,
      "No backend configured — set NEST_API_URL to the remote backend's base URL",
    );
    this.name = "BackendNotConfiguredError";
  }
}

/**
 * The session is alive but held back: there is a refresh token and no access
 * token. That is the state middleware leaves a request in when the backend
 * answered its refresh with `PASS_CODE_REQUIRED` (or rate-limited it) — a page
 * load gets redirected to /unlock, but a Server Action POST cannot follow a
 * redirect, so it runs on without a token and lands here.
 *
 * Thrown BEFORE calling the backend (the call could only be refused), so an
 * action can answer "locked" and its page can raise the PIN overlay instead of
 * showing a generic failure. A 401 subclass, so anything that already treats
 * ApiError 401 as "not signed in" still does.
 */
export class SessionLockedError extends ApiError {
  constructor(sentWith?: string) {
    super(401, "The session needs the PIN before it can continue");
    this.name = "SessionLockedError";
    this.sentWith = sentWith;
  }
}

/** The sign-in flow's own routes run without an access token by design. */
const SIGN_IN_PREFIX = "/v1/auth/";

/**
 * Who the backend should think is calling — see `./edge.ts` for why this
 * matters more than attribution.
 *
 * Every value comes from the request the BROWSER made, which `headers()` gives
 * us inside a Server Component or Action. Outside one — a build-time render —
 * it throws, and there is no browser to speak for anyway, so the call goes out
 * unattributed apart from our own User-Agent.
 *
 * ⚠️ The User-Agent forwarded here is the browser's, replacing the fixed string
 * this client used to send. That is not cosmetic: resume matching compares it
 * exactly, so a constant one made every caller look like every other.
 *
 * Exported for the one backend call that cannot go through `api`: the PIN
 * unlock, which must share `lib/auth/refresh.ts`'s single-flight exchange.
 */
export async function callerHeaders(): Promise<Record<string, string>> {
  try {
    const incoming = await headers();
    return edgeHeaders(
      {
        ip: incoming.get("CF-Connecting-IP"),
        country: incoming.get("CF-IPCountry"),
        userAgent: incoming.get("User-Agent"),
      },
      cfEnv("EDGE_SECRET"),
    );
  } catch {
    return { "User-Agent": FALLBACK_USER_AGENT };
  }
}

/**
 * Pull the human-readable message out of an error response.
 *
 * This backend nests errors: `{ error: { code, message, fields?,
 * correlation_id } }`. A top-level `message` is also accepted so the older
 * shape still works. Falls back to the status when the body isn't JSON at all —
 * which is exactly what a Cloudflare challenge page looks like.
 */
function errorMessage(payload: unknown, status: number): string {
  const p = payload as
    | { error?: { message?: string }; message?: string }
    | undefined;
  return (
    p?.error?.message ?? p?.message ?? `Request failed (${status})`
  );
}

type RequestOptions = Omit<RequestInit, "body"> & {
  /** JSON-serializable body; set automatically with the right Content-Type. */
  json?: unknown;
  /** Forwarded to fetch cache. Defaults to "no-store" for authed data. */
  cache?: RequestCache;
};

async function request<T>(
  path: string,
  options: RequestOptions = {},
  /**
   * The access token from the TOKEN_EXPIRED refresh, for the one retry it
   * earns — passed rather than re-read from the cookie it was just written to.
   * Set means "already retried": never twice.
   */
  retryWith?: string,
): Promise<T> {
  // `headers` is renamed on the way out of `options` — the import from
  // `next/headers` owns that name in this module now.
  const { json, headers: extraHeaders, cache = "no-store", ...rest } = options;

  const base = env.NEST_API_URL;
  if (!base) throw new BackendNotConfiguredError();

  const token = retryWith ?? (await getAccessToken());
  // Held back by middleware (see SessionLockedError) — refuse here rather than
  // send a call that can only come back 401. Never for the sign-in routes: a
  // fresh sign-in may legitimately run beside an old refresh cookie.
  if (!token && !path.startsWith(SIGN_IN_PREFIX) && (await getRefreshToken())) {
    throw new SessionLockedError();
  }
  // DEV ONLY — lets the locked path be exercised on demand. In real use the
  // app's own idle lock always comes first, so it is otherwise near-impossible
  // to reach. Set `root_dev_locked=1` in DevTools; never honoured in production.
  //
  // Server Actions only (Next marks them with the `Next-Action` header), which
  // is the one place the real case can happen — a page load is redirected to
  // /unlock by middleware instead. Applied to page loads too, a cookie left
  // behind failed the session read after unlocking and bounced to /login.
  // `/v1/me` is exempt for the same reason: an action's response re-renders the
  // page in the same request, and that render reads the session.
  if (
    !isProd &&
    !path.startsWith(SIGN_IN_PREFIX) &&
    path !== "/v1/me" &&
    (await headers()).has("next-action") &&
    (await cookies()).get("root_dev_locked")?.value === "1"
  ) {
    throw new SessionLockedError();
  }
  const caller = await callerHeaders();

  const res = await fetch(`${base}${path}`, {
    ...rest,
    cache,
    headers: {
      Accept: "application/json",
      ...caller,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const payload = await res
    .json()
    .catch(() => undefined as unknown);

  if (!res.ok) {
    // `Retry-After` is defined as either a delay in seconds or an HTTP date.
    // This backend sends seconds; anything that does not parse as a positive
    // integer is dropped rather than guessed at, and the caller falls back to
    // the body or to a default wait.
    const header = Number(res.headers.get("Retry-After"));
    const retryAfter =
      Number.isInteger(header) && header > 0 ? header : undefined;

    const error = new ApiError(
      res.status,
      errorMessage(payload, res.status),
      payload,
      retryAfter,
    );
    if (res.status === 401 && token && !path.startsWith(SIGN_IN_PREFIX)) {
      return unauthorized<T>(error, token, path, options, retryWith !== undefined);
    }
    throw error;
  }

  return payload as T;
}

/**
 * A 401 on an authenticated call — branched on the CODE, as the contract
 * requires before any global 401 handling (console-api.md §0 Errors, token-handling
 * §5). They do not all mean "signed out":
 *
 *   PASS_CODE_REQUIRED  the session is alive and wants the PIN → lock.
 *   TOKEN_EXPIRED       refresh (single-flight) and retry once. Only where
 *                       cookies can be written — a Server Action. A page render
 *                       cannot store a rotated pair, and refreshing without
 *                       storing it spends the token; there /api/auth/recover
 *                       drops the access cookie and middleware refreshes.
 *   anything else       UNAUTHENTICATED, TOKEN_REUSED, MFA_REQUIRED. Thrown
 *                       as it came, with the fingerprint of the token it was
 *                       sent with, so the caller can tell a session that ended
 *                       from a request that raced a rotation.
 *
 * Nothing here clears cookies on a mere API 401: the request may have been
 * sent with a token a newer response already replaced, and deleting cookies
 * would delete the NEW ones. Only a refresh that came back dead may.
 */
async function unauthorized<T>(
  error: ApiError,
  sentWith: string,
  path: string,
  options: RequestOptions,
  retried: boolean,
): Promise<T> {
  error.sentWith = await tokenFingerprint(sentWith);
  const body = apiErrorSchema.safeParse(error.body);
  const code = body.success ? body.data.error.code : undefined;

  if (code === ERROR_CODES.passCodeRequired) throw new SessionLockedError(error.sentWith);

  if (code === ERROR_CODES.tokenExpired && !retried && (await inServerAction())) {
    const refreshToken = await getRefreshToken();
    const base = env.NEST_API_URL;
    if (refreshToken && base) {
      const outcome = await refreshTokens(base, refreshToken, await callerHeaders());
      switch (outcome.status) {
        case "refreshed":
          await setAuthCookies(outcome.tokens);
          return request<T>(path, options, outcome.tokens.accessToken);
        case "locked":
        case "rejected":
          throw new SessionLockedError(error.sentWith);
        case "dead":
          console.warn(`[auth] refresh failed (${outcome.reason}) in an action — session cleared`);
          await clearAuthCookies();
          await setSessionEnded(outcome.message);
          break;
        // deferred / unreachable: unspent — keep everything, report the 401.
      }
    }
  }
  throw error;
}

/** Next marks Server Action requests with `Next-Action`; only they may set cookies here. */
async function inServerAction(): Promise<boolean> {
  try {
    return (await headers()).has("next-action");
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, json?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", json }),
  patch: <T>(path: string, json?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", json }),
  put: <T>(path: string, json?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PUT", json }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};

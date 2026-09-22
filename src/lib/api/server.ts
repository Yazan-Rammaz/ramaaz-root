import "server-only";
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { cfEnv } from "@/lib/cf-env";
import { getAccessToken } from "@/lib/auth/cookies";
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
 */
async function callerHeaders(): Promise<Record<string, string>> {
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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // `headers` is renamed on the way out of `options` — the import from
  // `next/headers` owns that name in this module now.
  const { json, headers: extraHeaders, cache = "no-store", ...rest } = options;

  const base = env.NEST_API_URL;
  if (!base) throw new BackendNotConfiguredError();

  const token = await getAccessToken();
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

    throw new ApiError(
      res.status,
      errorMessage(payload, res.status),
      payload,
      retryAfter,
    );
  }

  return payload as T;
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

import "server-only";
import { env } from "@/lib/env";
import { getAccessToken } from "@/lib/auth/cookies";

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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * No backend is wired yet (`NEST_API_URL` unset).
 *
 * The local `root-backend` was deleted and the remote one isn't configured, so
 * every call would otherwise fail somewhere deep in fetch with a DNS error. One
 * explicit 503 instead: screens still render, and anything that actually needs
 * data says plainly why it can't have any. `getSession()` reads this as
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
 * Identifies this client in the backend's logs.
 *
 * Not required to get through: the backend sits behind Cloudflare bot
 * protection, but Node's fetch is not challenged by it (curl is — a `curl/*`
 * UA gets a 403 HTML interstitial, which is a testing gotcha, not a runtime
 * one). Sent anyway so requests are attributable, and so a future tightening of
 * those bot rules doesn't take the dashboard down.
 */
const USER_AGENT = "RamaazRootDashboard/1.0";

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
  const { json, headers, cache = "no-store", ...rest } = options;

  const base = env.NEST_API_URL;
  if (!base) throw new BackendNotConfiguredError();

  const token = await getAccessToken();

  const res = await fetch(`${base}${path}`, {
    ...rest,
    cache,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const payload = await res
    .json()
    .catch(() => undefined as unknown);

  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(payload, res.status), payload);
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

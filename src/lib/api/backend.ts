import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { api, ApiError } from "./server";

/**
 * THE single way to call a PROJECT's own backend (RDB, Trydos, …). Server-only.
 *
 * The root dashboard manages several company projects; each row in the systems
 * registry carries the base URL of that project's backend. The user picks a
 * system on /systems (stored in the httpOnly `rdb_sys` cookie), and every
 * project-data page (regions, currencies, languages, …) reads and mutates
 * through `backendFetch` — same verbs as `api`, but routed to the SELECTED
 * system's backend instead of the root backend.
 *
 * ⚠️ The registry itself is currently unserved — see `features/system/api.ts`.
 * Until the remote backend provides it, `getSelectedSystem()` cannot resolve
 * and every call here fails before it reaches a project.
 *
 * Same BFF rules as `src/lib/api/server.ts`: the browser never calls a project
 * backend and never sees these URLs; Server Components read via features'
 * api.ts, browser mutations go through Server Actions.
 */

const SELECTED_SYSTEM = "rdb_sys";

/** What backendFetch needs from the registry — parsed defensively. */
const registryEntrySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  baseUrl: z.string(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** Thrown when no system is selected — pages can catch it and prompt. */
export class NoSystemSelectedError extends Error {
  constructor() {
    super("No system selected — pick a project on the Systems page first");
    this.name = "NoSystemSelectedError";
  }
}

/** Thrown when the selected system has no base URL configured yet. */
export class SystemNotConfiguredError extends Error {
  constructor(code: string) {
    super(`System "${code}" has no backend base URL yet — set it in the systems registry`);
    this.name = "SystemNotConfiguredError";
  }
}

export async function getSelectedSystemId(): Promise<string | null> {
  return (await cookies()).get(SELECTED_SYSTEM)?.value ?? null;
}

/** Cookie write — call from Server Actions only (Next.js restriction). */
export async function setSelectedSystemCookie(id: string) {
  (await cookies()).set(SELECTED_SYSTEM, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/**
 * The selected system's registry entry (id, code, name, baseUrl), or null when
 * nothing is selected. Deleted system → null too (stale cookie), so callers
 * degrade to the "pick a system" state.
 */
export async function getSelectedSystem(): Promise<RegistryEntry | null> {
  const id = await getSelectedSystemId();
  if (!id) return null;
  // Root backend call, not a project call; api.get attaches the access token.
  try {
    const data = await api.get<unknown>(`/systems/${encodeURIComponent(id)}`);
    return registryEntrySchema.parse(data);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  json?: unknown;
  cache?: RequestCache;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const system = await getSelectedSystem();
  if (!system) throw new NoSystemSelectedError();
  if (!system.baseUrl) throw new SystemNotConfiguredError(system.code);

  const { json, headers, cache = "no-store", ...rest } = options;

  const res = await fetch(`${system.baseUrl}${path}`, {
    ...rest,
    cache,
    headers: {
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      // Auth to project backends is per-system API keys (planned) — attach the
      // key for `system.code` here once the projects expose their admin APIs.
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => undefined as unknown);

  if (!res.ok) {
    const message =
      (payload as { message?: string } | undefined)?.message ??
      `${system.code} request failed (${res.status})`;
    throw new ApiError(res.status, message, payload);
  }

  return payload as T;
}

export const backendFetch = {
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

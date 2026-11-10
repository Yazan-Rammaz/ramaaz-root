import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
// `ApiError` is no longer thrown here — `api` raises it, with the backend's own
// error envelope and Retry-After already read off the response.
import { api } from "./server";
import { AUTH_PATHS, meResponseSchema, type WireProject } from "@/lib/auth/endpoints";

/**
 * THE single way to read a PROJECT's data (RDB, Trydos, …). Server-only.
 *
 * ── We never talk to a project backend. We talk to ours ─────────────────────
 * This file used to resolve a per-system `baseUrl` from the registry and fetch
 * that host directly. That design is gone, and it was never going to work:
 * confirmed in round 2 §2, the credentials for each managed system are held by
 * the root backend, encrypted at rest, and never leave it. There is no base URL
 * on a project entry and there won't be, and nothing authenticates US to a
 * project — the per-system keys live between the root backend and each system.
 *
 * So the root backend proxies, and every call here is an ordinary call to it
 * under `/v1/projects/{projectId}/…`. One trust boundary instead of N.
 *
 * The user still picks a system on /systems (httpOnly `root_sys` cookie), and
 * every project-data page reads through `backendFetch` — but the selection is
 * now a PATH SEGMENT rather than a host.
 *
 * ── What goes through it ────────────────────────────────────────────────────
 *   project data        POST …/operations/{name} — currencies, countries,
 *                       regions, languages, … (`./operations.ts`)
 *   what it offers      GET …/operations, …/permissions, …/unit-types
 *   roles               …/roles (the console's own routes)
 *
 * Same BFF rules as `src/lib/api/server.ts`: the browser never calls a backend
 * directly; Server Components read via features' api.ts, browser mutations go
 * through Server Actions.
 */

const SELECTED_SYSTEM = "root_sys";

/**
 * What backendFetch needs from the registry.
 *
 * A plain type, not a zod schema: the wire shape is already parsed by
 * `meResponseSchema` where it arrives, and a second parse of our own mapping
 * would only re-check fields we just wrote.
 *
 * No `baseUrl`. There is nothing to hold one — the id below IS the routing,
 * because it becomes a path segment on our own backend.
 */
export type RegistryEntry = {
  /** Also the `{projectId}` in every project-scoped path. */
  id: string;
  code: string;
  name: string;
  nameAr?: string;
  /** Line 3 of the card; older builds sent only `project_type`. */
  description?: string;
  status?: string;
  connectionStatus?: string;
  connectionError?: { code: string; message?: string };
  healthStatus?: string;
  /**
   * The backend's own "ACTIVE and CONNECTED". Missing (an older build) reads as
   * selectable: the backend refuses a call to an unavailable project anyway,
   * and locking everybody out of a list that never sent the field is worse.
   */
  selectable: boolean;
  myPermissions: string[];
};

/** The wire shape → our registry entry. Shared by `/v1/me` and the Systems routes. */
export function toRegistryEntry(p: WireProject): RegistryEntry {
  return {
    id: p.id,
    code: p.code ?? p.id,
    name: p.name ?? p.code ?? p.id,
    nameAr: p.name_ar,
    description: p.description ?? p.project_type,
    status: p.status,
    connectionStatus: p.connection_status,
    connectionError: p.connection_error,
    healthStatus: p.health_status,
    selectable: p.selectable ?? true,
    myPermissions: p.my_permissions ?? [],
  };
}

/** Thrown when no system is selected — pages can catch it and prompt. */
export class NoSystemSelectedError extends Error {
  constructor() {
    super("No system selected — pick a project on the Systems page first");
    this.name = "NoSystemSelectedError";
  }
}

/*
 * ⚰️ `SystemNotConfiguredError` used to live here — "this system has no backend
 * base URL yet". There is no such state any more: a system in the registry is
 * reachable by definition, because reaching it means asking our own backend
 * about an id it just gave us.
 */

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
/**
 * THE registry read — every managed system, from `projects` on `GET /v1/me`.
 *
 * It lives here rather than in `features/system/api.ts` because this file needs
 * it too, and `lib` may not import from `features`. The feature module maps
 * these onto its own UI shape; nothing else should read `projects` directly.
 *
 * `code` and `name` fall back to the id: they are documented as present, but an
 * entry that arrived without one must still be selectable rather than take the
 * whole list down.
 */
export async function listRegistry(): Promise<RegistryEntry[]> {
  const raw = await api.get<unknown>(AUTH_PATHS.me);
  const projects = meResponseSchema.parse(raw).projects ?? [];

  return projects.map(toRegistryEntry);
}

export async function getSelectedSystem(): Promise<RegistryEntry | null> {
  const id = await getSelectedSystemId();
  if (!id) return null;
  return selectableEntry(id);
}

/**
 * The registry lookup behind `getSelectedSystem`, memoised for one request and
 * keyed on the selected id. Every project call resolves the selection, and one
 * screen makes dozens of them (every page of a list, every country's regions);
 * without this each was its own `GET /v1/me`. Keyed on the id, so selecting
 * another system inside a request still looks it up afresh.
 */
const selectableEntry = cache(async (id: string): Promise<RegistryEntry | null> => {
  // A system that has since been removed resolves to null (stale cookie), so
  // callers degrade to the "pick a system" state rather than erroring. So does
  // one that is no longer `selectable` (its connection failed, it was
  // suspended, or the cookie predates the rule): every data call to it is
  // refused, so the shell must not open its pages.
  return (await listRegistry()).find((s) => s.id === id && s.selectable) ?? null;
});

/**
 * Prefix a project-scoped path with the selected system.
 *
 * `/org-units` → `/v1/projects/01ABC…/org-units`. That is the entire job now:
 * no second host, no second fetch, no second set of credentials.
 */
async function projectPath(path: string): Promise<string> {
  const system = await getSelectedSystem();
  if (!system) throw new NoSystemSelectedError();

  return `/v1/projects/${encodeURIComponent(system.id)}${path}`;
}

/**
 * Same verbs as `api`, scoped to the selected project.
 *
 * Every one of these is an ordinary root-backend call underneath, so it
 * inherits the bearer token, the caller headers from `./edge.ts`, the error
 * envelope and the `Retry-After` handling without restating any of it. The only
 * thing this adds is the path prefix and the "nothing selected" refusal.
 */
export const backendFetch = {
  get: async <T>(path: string, options?: Parameters<typeof api.get>[1]) =>
    api.get<T>(await projectPath(path), options),
  post: async <T>(path: string, json?: unknown, options?: Parameters<typeof api.post>[2]) =>
    api.post<T>(await projectPath(path), json, options),
  patch: async <T>(path: string, json?: unknown, options?: Parameters<typeof api.patch>[2]) =>
    api.patch<T>(await projectPath(path), json, options),
  put: async <T>(path: string, json?: unknown, options?: Parameters<typeof api.put>[2]) =>
    api.put<T>(await projectPath(path), json, options),
  delete: async <T>(path: string, options?: Parameters<typeof api.delete>[1]) =>
    api.delete<T>(await projectPath(path), options),
};

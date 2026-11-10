import "server-only";
import { z } from "zod";
import { api } from "@/lib/api/server";
import { listRegistry, toRegistryEntry, type RegistryEntry } from "@/lib/api/backend";
import { wireProjectSchema } from "@/lib/auth/endpoints";
import {
  systemSchema,
  type CreateProjectInput,
  type System,
} from "./schema";

/**
 * Single place system data is read and written. Server-only.
 *
 * The LIST rides on the session (`projects` on `GET /v1/me`); `lib/api/backend.ts`
 * owns that read because it needs the same data to route project calls, and
 * `lib` may not import from `features`. Adding and connecting a project are the
 * Systems routes in console-api.md §5, all on the root backend.
 *
 * For a root administrator the registry is EVERY non-archived project, so an
 * empty list means none is registered yet, not that none is visible.
 */

/** Every Systems-page path (console-api.md §5). Remap here if anything moves. */
const PATHS = {
  projects: "/v1/projects",
  project: (id: string) => `/v1/projects/${encodeURIComponent(id)}`,
  connection: (id: string) => `/v1/projects/${encodeURIComponent(id)}/connection`,
} as const;

/** The one part of `GET /v1/projects/{id}` read here (§5.1): the saved connection. */
const projectDetailSchema = z.object({
  connection: z.object({ base_url: z.string().optional() }).loose().optional(),
});

/** Registry entry → the row the UI renders. */
function toSystem(entry: RegistryEntry): System {
  return {
    id: entry.id,
    code: entry.code,
    name: entry.name,
    // An entry with no description still renders its name rather than collapsing.
    description: entry.description ?? "",
    status: entry.status,
    connectionStatus: entry.connectionStatus,
    connectionError: entry.connectionError,
    selectable: entry.selectable,
  };
}

/** A project as the Systems routes return it → the same row shape. */
function parseProject(raw: unknown): System {
  return systemSchema.parse(toSystem(toRegistryEntry(wireProjectSchema.parse(raw))));
}

export async function listSystems(): Promise<System[]> {
  return systemSchema.array().parse((await listRegistry()).map(toSystem));
}

export async function getSystem(id: string): Promise<System | null> {
  return (await listSystems()).find((s) => s.id === id) ?? null;
}

/** Step 1 — `201`, the project as DRAFT / NOT_CONNECTED. Nothing is called yet. */
export async function createProject(input: CreateProjectInput): Promise<System> {
  return parseProject(await api.post<unknown>(PATHS.projects, input));
}

/**
 * Step 2 — save the URL and run the handshake. `200` whether or not the
 * handshake succeeded: the outcome is `connectionStatus` / `connectionError`
 * on the returned project, never a thrown error.
 */
export async function connectProject(id: string, baseUrl: string): Promise<System> {
  return parseProject(await api.put<unknown>(PATHS.connection(id), { base_url: baseUrl }));
}

/**
 * The base URL saved by the last connect, to pre-fill the connect step. Connect
 * saves the URL even when the handshake then fails (only a URL the rules refuse
 * is not saved), so this is what the admin last tried.
 *
 * Undefined on any failure: a pre-fill is a convenience, and the step must still
 * open when this read doesn't.
 */
export async function getSavedBaseUrl(id: string): Promise<string | undefined> {
  try {
    const raw = await api.get<unknown>(PATHS.project(id));
    return projectDetailSchema.parse(raw).connection?.base_url;
  } catch {
    return undefined;
  }
}

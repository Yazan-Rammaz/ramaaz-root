import "server-only";
import { listRegistry, type RegistryEntry } from "@/lib/api/backend";
import { systemSchema, type System } from "./schema";

/**
 * Single place system data is read. Server-only.
 *
 * ── There is no /systems route. The registry rides on the session ───────────
 * The list of company projects used to live in the local `root-backend`, which
 * was deleted, and this file called a `/systems` that nothing served. The remote
 * backend serves it as `projects` on `GET /v1/me` instead — confirmed
 * 2026-09-22 — so `lib/api/backend.ts` owns the read (it needs the same data to
 * route project calls, and `lib` may not import from `features`) and this maps
 * it onto the shape the screen renders.
 *
 * For a root administrator the registry is EVERY registered system, so an empty
 * list means none is registered yet, not that none is visible.
 *
 * It carries no base URL, and needs none: the root backend proxies project data
 * and the entry's `id` becomes a path segment — `/v1/projects/{id}/…`. See
 * `lib/api/backend.ts`.
 */

/**
 * Registry entry → the row the UI renders.
 *
 * `description` is the one field the wire shape has no equivalent for: the
 * screen shows a one-line category under each name, and the nearest thing the
 * backend sends is `project_type`. Falling back to the code keeps the row from
 * collapsing, and an entry with neither still renders its name.
 */
function toSystem(entry: RegistryEntry): System {
  return {
    id: entry.id,
    code: entry.code,
    name: entry.name,
    description: entry.projectType ?? entry.code,
  };
}

export async function listSystems(): Promise<System[]> {
  return systemSchema.array().parse((await listRegistry()).map(toSystem));
}

export async function getSystem(id: string): Promise<System | null> {
  return (await listSystems()).find((s) => s.id === id) ?? null;
}

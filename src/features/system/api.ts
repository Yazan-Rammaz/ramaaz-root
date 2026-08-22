import "server-only";
import { api } from "@/lib/api/server";
import { systemSchema, type System } from "./schema";

/**
 * Single place system endpoints are read. Server-only.
 *
 * ⚠️ HOMELESS UNTIL THE REMOTE BACKEND LANDS. The systems registry — the list
 * of company projects and the base URL of each one's backend — used to live in
 * the local `root-backend`, which has been deleted. Nothing serves `/systems`
 * right now, so these calls fail with `BackendNotConfiguredError` (no backend
 * wired) or 404 (wired, but no registry there).
 *
 * That matters beyond this screen: `lib/api/backend.ts` resolves the selected
 * system through here, so every project-data page depends on it. The remote
 * backend needs to either serve this registry or the base URLs need another
 * home. Responses stay schema-parsed so drift fails loud.
 */
export async function listSystems(): Promise<System[]> {
  const data = await api.get<unknown>("/systems");
  return systemSchema.array().parse(data);
}

export async function getSystem(id: string): Promise<System> {
  const data = await api.get<unknown>(`/systems/${encodeURIComponent(id)}`);
  return systemSchema.parse(data);
}

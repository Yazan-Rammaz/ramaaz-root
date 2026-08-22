import "server-only";
import { regionSchema, type Region } from "./schema";

/**
 * Single place region endpoints are read. Server-only.
 *
 * Regions are PROJECT data — they live in the SELECTED system's own backend
 * (rdb, trydos, …), not in the root backend. MOCK — empty for now (matches the XD
 * "No countries added yet" state). When the project backends expose regions,
 * swap for the selected-system call, keeping the schema.parse boundary:
 *   const data = await backendFetch.get<unknown>("/regions");
 *   return regionSchema.array().parse(data);
 * (import { backendFetch } from "@/lib/api/backend"). Nothing else changes.
 */
const MOCK_REGIONS: unknown[] = [];

export async function listRegions(): Promise<Region[]> {
  return regionSchema.array().parse(MOCK_REGIONS);
}

export async function getRegion(id: string): Promise<Region> {
  const found = MOCK_REGIONS.find(
    (r): r is { id: string } =>
      typeof r === "object" && r !== null && (r as { id?: unknown }).id === id,
  );
  return regionSchema.parse(found);
}

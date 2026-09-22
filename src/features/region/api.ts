import "server-only";
import { regionSchema, type Region } from "./schema";

/**
 * Single place region endpoints are read. Server-only.
 *
 * Regions are PROJECT data — scoped to the system selected on /systems, and
 * served by the root backend on that project's behalf. MOCK — empty for now,
 * which matches the XD "No countries added yet" state. The swap is:
 *
 *   const data = await backendFetch.get<unknown>("/org-units");
 *   return regionSchema.array().parse(data);   // filtered to region units
 *
 * (import { backendFetch } from "@/lib/api/backend" — it prefixes
 * `/v1/projects/{selected}` for you.)
 *
 * ⚠️ THE LEAST SPECIFIED OF THE THREE, and `regionSchema` still carries a
 * literal TODO. Two things have to be settled first, and neither is a mapping
 * detail:
 *
 *  1. **Which `type` means "region".** `/org-units` is the whole mirrored
 *     directory — regions, branches, everything — and `/unit-types` describes
 *     what nests where. We do not know whether to filter on a stable
 *     identifier or read the types first and pick by some property.
 *  2. **It is a TREE.** This screen is a flat list. If regions are really one
 *     level of a hierarchy, that is a different screen, and better known now
 *     than after it is built.
 *
 * Asked in `backend docs/frontend-project-data-needs.md`.
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

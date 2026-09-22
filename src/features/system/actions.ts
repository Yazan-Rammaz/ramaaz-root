"use server";

import { revalidatePath } from "next/cache";
import { setSelectedSystemCookie } from "@/lib/api/backend";
import { getSystem } from "./api";

/**
 * Select the system (company project) the dashboard works on. Every
 * project-data page (regions, currencies, languages, …) reads and mutates
 * through the selected system's own backend via `backendFetch`.
 */
export async function selectSystem(id: string): Promise<void> {
  // Resolve against the registry first — an unknown id (stale UI, tampering)
  // must not land in the cookie.
  //
  // `getSystem` answers null rather than throwing now: the registry is a list
  // on the session response, not a route that can 404, so "not in it" is an
  // ordinary answer. Refuse silently — the id came from our own list, so a miss
  // means that list moved, and re-rendering shows the current one.
  const system = await getSystem(id);
  if (!system) return;

  await setSelectedSystemCookie(system.id);
  // The data source of every project page just changed.
  revalidatePath("/", "layout");
}

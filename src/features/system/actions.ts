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
  // must not land in the cookie. getSystem throws on 404.
  const system = await getSystem(id);
  await setSelectedSystemCookie(system.id);
  // The data source of every project page just changed.
  revalidatePath("/", "layout");
}

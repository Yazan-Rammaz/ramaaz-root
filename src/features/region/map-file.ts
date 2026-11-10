"use client";

import type { GeoImage } from "./mock-geo";

/**
 * A country map the person picked in place of the generated one. SVG only,
 * up to 256 KB, checked here at once.
 *
 * ⚠️ Kept on the screen only: RDB has no field for a country's map (it has
 * `flagImageUrl` for the flag, nothing for a map), so a picked map lasts until
 * the page reloads, then the generated one is back. When RDB gains a field,
 * this is what gets uploaded.
 */

export type MapProblem = "type" | "size";

const MAX_MAP_BYTES = 256 * 1024;

/** The XD map box (Turkiye's 62 × 26); a picked map is fitted inside it. */
const MAP_BOX = { w: 62, h: 26 };

export async function readPickedMap(
  file: File,
): Promise<GeoImage | MapProblem> {
  if (file.type !== "image/svg+xml") return "type";
  if (file.size === 0 || file.size > MAX_MAP_BYTES) return "size";
  // A data: URL — the CSP allows `data:` images, and nothing leaves the browser.
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { icon: "", src, ...MAP_BOX };
}

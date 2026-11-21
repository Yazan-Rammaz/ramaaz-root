"use client";

import type { GeoImage } from "./mock-geo";

/**
 * A country map the person picked in place of the generated one. SVG only,
 * up to 256 KB, checked here at once.
 *
 * Saved to RDB once the place is saved (`saveMapAction`: `media.upload`, then
 * `mapImageUrl`), and drawn from there after a reload (`/api/geo-map`).
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

/** A picked map's file for `media.upload` (base64, no `data:` prefix); none for a drawn or matched one. */
export function svgBase64(image?: GeoImage | null): string | undefined {
  const prefix = "data:image/svg+xml;base64,";
  return image?.src?.startsWith(prefix) ? image.src.slice(prefix.length) : undefined;
}

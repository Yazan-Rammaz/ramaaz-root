"use server";

import type { GeoImage } from "./mock-geo";
import { findRegionMap, shapeIdOf } from "./region-map";

/**
 * The map for a region being added — the same match the tree uses on load
 * (`region-map.ts`), so a region looks the same before and after a reload.
 * `parentMap` is the parent's map (its shape id narrows a district to its
 * province); `level` is 1 for a province. Null when nothing matches.
 */
export async function regionMapAction(input: {
  countryCode: string;
  level: number;
  parentMap?: GeoImage;
  isoCode?: string;
  names: string[];
}): Promise<GeoImage | null> {
  return (
    findRegionMap({
      countryCode: input.countryCode,
      level: input.level,
      parentShapeId: shapeIdOf(input.parentMap),
      isoCode: input.isoCode,
      names: input.names,
    })?.image ?? null
  );
}

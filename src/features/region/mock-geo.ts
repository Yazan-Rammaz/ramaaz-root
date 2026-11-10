/**
 * The geographic tree's node shape for the Countries tab (XD "Fixes" frame),
 * now filled from RDB by `api.ts`; the static XD tree that used to live here is
 * gone. A country
 * expands its level-1 divisions inline below itself; every deeper level opens
 * as a new column toward the end side, starting at its parent's row. Bitmap
 * thumbnails are the XD exports in /public/icons/regions/geo, recorded at
 * their native XD pixel sizes.
 */
import type { LocalizedName } from "@/lib/i18n/localized";
import { FLAG_CODES } from "./flag-codes";
import { ALPHA3_TO_ALPHA2 } from "./iso-alpha3";
import { MAP_SIZES } from "./map-sizes";
import type { CountryDraft } from "./mock-ai";

export type GeoImage = {
  /** A file in /public/icons (`<Icon name>`). */
  icon: string;
  w: number;
  h: number;
  /** A picked file instead (`data:` URL), fitted inside w × h — see `GeoThumb`. */
  src?: string;
};

export type GeoNode = {
  id: string;
  name: string;
  /** Short-code text chip (TR, IST, …). */
  code?: string;
  /** Second text chip — the province plate number (34, 06, …). */
  plate?: string;
  /** Flag thumbnail (countries only); added countries fall back to the emoji flag. */
  flag?: GeoImage;
  /** Map / shape thumbnail. */
  map?: GeoImage;
  /**
   * The full saved sheet (countries only): translations, language, currency,
   * general info and the level order — shown by the detail drawer and the
   * source of the "Add {country} {level}" labels.
   */
  details?: CountryDraft;
  /** Its name as RDB stores it, in every language it has — what Edit starts from. */
  names?: LocalizedName;
  /** RDB's `updatedAt` as read — sent back on an edit so a stale save is refused. */
  updatedAt?: string;
  /** A region's type key (`province`), which Edit can change. */
  regionType?: string;
  /**
   * A closed country: greyed in the tree, read-only, and only Reopen is
   * offered (2026-11-08 closed-country note). Closed regions are not listed.
   */
  closed?: boolean;
  children: GeoNode[];
};

/** Root→node chain for the node with the given id, or null. */
export function findPathById(nodes: GeoNode[], id: string): GeoNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const sub = findPathById(n.children, id);
    if (sub) return [n, ...sub];
  }
  return null;
}

/** Immutably change the node with the given id (an edit just saved). */
export function updateById(
  nodes: GeoNode[],
  id: string,
  patch: Partial<GeoNode>,
): GeoNode[] {
  return nodes.map((n) =>
    n.id === id
      ? { ...n, ...patch }
      : { ...n, children: updateById(n.children, id, patch) },
  );
}

/** Immutably drop the node with the given id (and what is below it) — a closed one. */
export function removeById(nodes: GeoNode[], id: string): GeoNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: removeById(n.children, id) }));
}

/** Immutably append a child under the node with the given id. */
export function addChildById(
  nodes: GeoNode[],
  parentId: string,
  child: GeoNode,
): GeoNode[] {
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: [...n.children, child] }
      : { ...n, children: addChildById(n.children, parentId, child) },
  );
}

const geo = (file: string, w: number, h: number): GeoImage => ({
  icon: `regions/geo/${file}`,
  w,
  h,
});

/**
 * A country's 2-letter ISO code, upper case, from either kind people type or
 * save: `JO` stays `JO`, `JOR` becomes `JO`. "" for anything else — a
 * 3-letter code is never cut to its first two letters (ARE is the Emirates,
 * AR is Argentina).
 */
export function toAlpha2(code: string) {
  const cc = code.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(cc)) return cc;
  return ALPHA3_TO_ALPHA2.get(cc) ?? "";
}

/** Country code -> flag emoji (regional indicators); "" when not derivable. */
export function flagEmoji(code: string) {
  const cc = toAlpha2(code);
  if (!cc) return "";
  return String.fromCodePoint(
    ...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

/**
 * 2-letter code -> the real flag bitmap (XD exports) for every country the
 * mock recognizes. A statically-seeded row (Turkiye, Iraq, Lebanon, …) and a
 * country ADDED THROUGH THE DRAWER with a matching short code render the
 * exact same flag — so nothing looks different just because it was typed in
 * rather than pre-seeded. Only falls back to `flagEmoji` for a code with no
 * asset here.
 */
export const COUNTRY_FLAGS: Record<string, GeoImage> = {
  TR: geo("flag-tr.png", 26, 26),
  IQ: geo("flag-iq.png", 26, 26),
  LB: geo("flag-lb.png", 26, 26),
  SY: geo("flag-sy.svg", 26, 18),
};

/**
 * Resolve the flag for a short code: the XD bitmap where the design has one,
 * else the bundled flag set (`/public/icons/flags`, every ISO country), else
 * undefined (caller falls back to `flagEmoji`). Automatic for any country —
 * nobody has to upload a flag.
 */
export function resolveFlag(code: string): GeoImage | undefined {
  const cc = toAlpha2(code);
  if (COUNTRY_FLAGS[cc]) return COUNTRY_FLAGS[cc];
  const lower = cc.toLowerCase();
  // 4:3 at the XD flag chip's 26px width.
  return FLAG_CODES.has(lower) ? { icon: `flags/${lower}`, w: 26, h: 20 } : undefined;
}

/**
 * A country's map thumbnail by its 2-letter code: the XD export for Turkiye
 * (it carries the province borders), else the generated set in
 * `/public/icons/maps` (scripts/gen-country-maps.mjs, every ISO country, the
 * same green). Undefined for a code with no map — the box stays empty rather
 * than showing another country's outline.
 */
export function countryMap(code: string): GeoImage | undefined {
  const cc = toAlpha2(code).toLowerCase();
  if (cc === "tr") return geo("map-turkiye.png", 62, 26);
  const size = MAP_SIZES[cc];
  return size ? { icon: `maps/${cc}`, w: size[0], h: size[1] } : undefined;
}

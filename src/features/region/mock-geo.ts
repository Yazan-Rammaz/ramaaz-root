/**
 * Mock geographic tree for the Countries tab (XD "Fixes" frame). A country
 * expands its level-1 divisions inline below itself; every deeper level opens
 * as a new column toward the end side, starting at its parent's row. Bitmap
 * thumbnails are the XD exports in /public/icons/regions/geo, recorded at
 * their native XD pixel sizes.
 */
import { generateCountry, type CountryDraft } from "./mock-ai";

export type GeoImage = { icon: string; w: number; h: number };

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

/** 2-letter code -> flag emoji (regional indicators); "" when not derivable. */
export function flagEmoji(code: string) {
  const cc = code.trim().toUpperCase().slice(0, 2);
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return "";
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

/** Resolve the real flag for a short code, or undefined (caller falls back
 *  to `flagEmoji`). */
export function resolveFlag(code: string): GeoImage | undefined {
  return COUNTRY_FLAGS[code.trim().toUpperCase()];
}

const NEIGHBORHOOD = geo("chip-neighborhood.png", 20, 20);

const PROVINCE_MAPS = [
  geo("map-istanbul.png", 52, 26),
  geo("map-mersin.png", 39, 26),
  geo("map-ankara.png", 30, 26),
  geo("map-gaziantep.png", 39, 26),
];
const DISTRICT_CHIPS = [
  geo("chip-fatih.png", 25, 26),
  geo("chip-sariyer.png", 25, 26),
];

/**
 * Auto-assign a map thumbnail to a manually added node so no box stays empty
 * (mock: cycles the XD exports). depth 0 = country, 1 = level 1, ….
 */
export function placeholderMap(depth: number, index: number): GeoImage {
  if (depth === 0) return geo("map-turkiye.png", 62, 26);
  if (depth === 1) return PROVINCE_MAPS[index % PROVINCE_MAPS.length];
  if (depth === 2) return DISTRICT_CHIPS[index % DISTRICT_CHIPS.length];
  return NEIGHBORHOOD;
}

export const GEO_TREE: GeoNode[] = [
  {
    id: "tr",
    code: "TR",
    name: "Turkiye",
    flag: COUNTRY_FLAGS.TR,
    map: geo("map-turkiye.png", 62, 26),
    details: generateCountry("TR", "Turkiye"),
    children: [
      {
        id: "ist",
        code: "IST",
        plate: "34",
        name: "Istanbul",
        map: geo("map-istanbul.png", 52, 26),
        children: [
          {
            id: "fatih",
            name: "Fatih",
            map: geo("chip-fatih.png", 25, 26),
            children: [],
          },
          {
            id: "sariyer",
            name: "Sariyer",
            map: geo("chip-sariyer.png", 25, 26),
            children: [
              { id: "vad-1", name: "Vadistanbul", map: NEIGHBORHOOD, children: [] },
              { id: "vad-2", name: "Vadistanbul", map: NEIGHBORHOOD, children: [] },
              { id: "vad-3", name: "Vadistanbul", map: NEIGHBORHOOD, children: [] },
              { id: "vad-4", name: "Vadistanbul", map: NEIGHBORHOOD, children: [] },
            ],
          },
        ],
      },
      {
        id: "mer",
        code: "MER",
        plate: "33",
        name: "Mersin",
        map: geo("map-mersin.png", 39, 26),
        children: [],
      },
      {
        id: "ank",
        code: "ANK",
        plate: "06",
        name: "Ankara",
        map: geo("map-ankara.png", 30, 26),
        children: [],
      },
      {
        id: "gza",
        code: "GZA",
        plate: "27",
        name: "Gaziantep",
        map: geo("map-gaziantep.png", 39, 26),
        children: [],
      },
    ],
  },
  {
    id: "iq",
    code: "IQ",
    name: "Iraq",
    flag: COUNTRY_FLAGS.IQ,
    map: geo("map-turkiye.png", 62, 26),
    children: [],
  },
  {
    id: "lb",
    code: "LB",
    name: "Lebanon",
    flag: COUNTRY_FLAGS.LB,
    map: geo("map-turkiye.png", 62, 26),
    children: [],
  },
];

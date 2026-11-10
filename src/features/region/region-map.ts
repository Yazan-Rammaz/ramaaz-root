import "server-only";
import { toAlpha2, type GeoImage } from "./mock-geo";
import { REGION_SHAPES, type RegionShape } from "./region-shapes";

/**
 * Finds a region's map among the generated ones (scripts/gen-region-maps.mjs):
 * provinces for every country, districts and sub-districts for the countries
 * listed there. Server-only — the index is large.
 *
 * A province is found by its ISO 3166-2 code first (`SY-HL`), then by name; a
 * deeper region by name, inside the shape its parent matched. Names are
 * compared loosely: accents, "al-" / "ال", words like "Province" / "محافظة"
 * and punctuation do not count, and one letter of difference is forgiven
 * ("Tartos" finds Tartus). An unclear match — two shapes as close — is no
 * match: a wrong outline is worse than none.
 *
 * Only what RDB does not hold yet: once regions have a map field (to-backend
 * 2026-11-02-maps.md), the stored map wins and this is the default for a new one.
 */

const STOP_WORDS =
  /\b(governorate|province|region|district|state|county|municipality|city|muhafazat|il|ili|ilcesi|qada|kaza)\b|محافظة|ولاية|منطقة|قضاء|مدينة|لواء/gi;

export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ًͯ-ٟـ]/g, "") // accents, Arabic vowels, tatweel
    .toLowerCase()
    .replace(STOP_WORDS, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/(^|\s)(al|el|as|ad|ar|ash|at|az|an)[\s'’`-]+/g, "$1")
    .replace(/(^|\s)ال/g, "$1")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Edit distance, stopped early once past `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...row) > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

const keysCache = new Map<RegionShape, string[]>();
function keysOf(shape: RegionShape): string[] {
  let keys = keysCache.get(shape);
  if (!keys) {
    keys = [...new Set(shape[5].split("|").map(normalizeName).filter(Boolean))];
    keysCache.set(shape, keys);
  }
  return keys;
}

/**
 * 0 = its main name, 0.5 = one of its other names, 1 = one letter off,
 * Infinity = no. Main beats other so a province is not lost to a neighbour
 * that lists it as an alternative (Damascus vs Rif Dimashq).
 */
function distance(shape: RegionShape, wanted: string[]): number {
  const main = new Set(shape[5].split("|").slice(0, 2).map(normalizeName));
  let best = Infinity;
  for (const key of keysOf(shape)) {
    for (const w of wanted) {
      if (key === w) best = Math.min(best, main.has(key) ? 0 : 0.5);
      else if (best > 1 && w.length >= 5 && within(key, w, 1)) best = 1;
    }
  }
  return best;
}

export type RegionMatch = { image: GeoImage; shapeId: string };

/**
 * The map for a region of `countryCode` at `level` (1 = province), under the
 * parent shape `parentShapeId` (the parent's match; "" for a province or when
 * the parent had none). `names` in any language RDB or the person gave.
 */
export function findRegionMap({
  countryCode,
  level,
  parentShapeId,
  isoCode,
  names,
}: {
  countryCode: string;
  level: number;
  parentShapeId?: string;
  isoCode?: string | null;
  names: string[];
}): RegionMatch | undefined {
  // JOR and JO alike (a country may be saved with either).
  const cc = toAlpha2(countryCode).toLowerCase();
  const shapes = (REGION_SHAPES[cc] ?? []).filter((s) => s[1] === level);
  if (!shapes.length) return undefined;

  let found: RegionShape | undefined;
  // A province's ISO code is its file name (SY-HL → hl).
  const suffix = isoCode?.split("-")[1]?.toLowerCase();
  if (level === 1 && suffix) found = shapes.find((s) => s[0] === suffix);

  if (!found) {
    const wanted = [...new Set(names.map(normalizeName).filter(Boolean))];
    if (!wanted.length) return undefined;
    // Inside the parent's shape when it matched; otherwise the whole country.
    const pool = parentShapeId
      ? shapes.filter((s) => s[2] === parentShapeId)
      : shapes;
    const scored = pool
      .map((s) => ({ s, d: distance(s, wanted) }))
      .filter((x) => x.d < Infinity)
      .sort((a, b) => a.d - b.d);
    if (scored.length && (scored.length === 1 || scored[0].d < scored[1].d))
      found = scored[0].s;
  }
  if (!found) return undefined;
  return {
    shapeId: found[0],
    image: { icon: `maps/regions/${cc}/${found[0]}`, w: found[3], h: found[4] },
  };
}

/** The shape id inside a map's icon path (`maps/regions/sy/hl` → `hl`), for its children. */
export function shapeIdOf(image: GeoImage | undefined): string | undefined {
  const m = image?.icon.match(/^maps\/regions\/[a-z]{2}\/(.+)$/);
  return m?.[1];
}

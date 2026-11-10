#!/usr/bin/env node
/**
 * Generates the region map thumbnails in public/icons/maps/regions/{cc}/ and
 * their index, src/features/region/region-shapes.ts (server-only: it is large,
 * and matching runs on the server — src/features/region/region-map.ts).
 *
 *   Level 1 (provinces), EVERY country — Natural Earth 1:10m admin-1 (public
 *     domain), with ISO 3166-2 codes and alternative names. Fill #BCD9C1, the
 *     XD province thumbnails' pale green (regions/geo/map-istanbul.png).
 *   Levels 2–3 (districts, sub-districts), the countries in DETAIL_COUNTRIES —
 *     geoBoundaries gbOpen ADM2/ADM3 (CC BY; attribution in the folder's
 *     README). Fill #C3C3C3, the XD district chips' grey (chip-fatih.png).
 *     Every country of the world would be ~50,000 files, past Cloudflare's
 *     20,000-asset limit, so it is a list: add a country, re-run.
 *
 * Each shape records its parent (a district's province, by which one contains
 * its centre), so a district is matched inside the right province.
 *
 * Downloads are cached in node_modules/.cache/geo. Output is committed.
 *   node scripts/gen-region-maps.mjs
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { geoCentroid, geoContains } from "d3-geo";
import rewind from "@mapbox/geojson-rewind";
import countries from "i18n-iso-countries";
import { renderThumb } from "./geo-svg.mjs";

/** Countries that also get districts and sub-districts (ISO 3166-1 alpha-2). */
const DETAIL_COUNTRIES = ["SY", "TR", "IQ", "LB", "JO"];

const PROVINCE = { fill: "#BCD9C1", boxFor: wideBox };
const DISTRICT = { fill: "#C3C3C3", boxFor: squareBox };

/** Level 1 sits in the wide box, like a country: 62 × 26, tall shapes to 36. */
function wideBox(aspect) {
  if (aspect >= 62 / 26) return { w: 62, h: 62 / aspect };
  if (aspect >= 1) return { w: 26 * aspect, h: 26 };
  return { w: 36 * aspect, h: 36 };
}
/** Deeper levels sit in the square chip: 26 on the longer side. */
function squareBox(aspect) {
  return aspect >= 1 ? { w: 26, h: 26 / aspect } : { w: 26 * aspect, h: 26 };
}

const cacheDir = new URL("../node_modules/.cache/geo/", import.meta.url);
mkdirSync(cacheDir, { recursive: true });

async function cached(name, url) {
  const file = new URL(name, cacheDir);
  if (!existsSync(file)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return rewind(JSON.parse(readFileSync(file, "utf8")), true);
}

/** geoBoundaries for one country and level, or null when it has none. */
async function geoBoundaries(iso3, level) {
  const name = `gb-${iso3}-${level}.geojson`;
  if (!existsSync(new URL(name, cacheDir))) {
    const meta = await fetch(
      `https://www.geoboundaries.org/api/current/gbOpen/${iso3}/${level}/`,
    );
    if (!meta.ok) return null;
    const url = (await meta.json()).simplifiedGeometryGeoJSON;
    if (!url) return null;
    return cached(name, url);
  }
  return cached(name, "");
}

const outDir = new URL("../public/icons/maps/regions/", import.meta.url);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** cc → [id, level, parentId, w, h, names] */
const index = {};
let files = 0;

function write(cc, id, level, parent, feature, style, names) {
  const thumb = renderThumb(feature, style);
  if (!thumb) return false;
  const dir = new URL(`${cc}/`, outDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${id}.svg`, dir), thumb.svg);
  const unique = [...new Set(names.map((n) => n?.trim()).filter(Boolean))];
  (index[cc] ??= []).push([
    id,
    level,
    parent,
    thumb.w,
    thumb.h,
    unique.join("|"),
  ]);
  files++;
  return true;
}

// ── Level 1: Natural Earth admin-1, every country ─────────────────────────
const ne = await cached(
  "ne_10m_admin_1_states_provinces.geojson",
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson",
);
/** cc → [{ id, feature }] — the parents districts are placed in. */
const provinces = {};
for (const f of ne.features) {
  const p = f.properties;
  const cc = String(p.iso_a2 ?? "").toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) continue;
  // The ISO 3166-2 part after the hyphen (SY-HL → hl) is the file name, so a
  // region saved with that code finds it directly.
  const suffix = String(p.iso_3166_2 ?? "")
    .split("-")[1]
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const taken = new Set((index[cc] ?? []).map((e) => e[0]));
  const id = suffix && !taken.has(suffix) ? suffix : `x${taken.size}`;
  const names = [
    p.name,
    p.name_en,
    p.gn_name,
    p.woe_name,
    ...String(p.name_alt ?? "").split("|"),
    p.name_ar,
    p.name_tr,
  ];
  if (write(cc, id, 1, "", f, PROVINCE, names)) {
    (provinces[cc] ??= []).push({ id, feature: f });
  }
}
console.log(`level 1: ${files} provinces`);

// ── Levels 2–3: geoBoundaries, DETAIL_COUNTRIES ───────────────────────────
for (const CC of DETAIL_COUNTRIES) {
  const cc = CC.toLowerCase();
  const iso3 = countries.alpha2ToAlpha3(CC);
  let parents = provinces[cc] ?? [];
  for (const [level, adm] of [
    [2, "ADM2"],
    [3, "ADM3"],
  ]) {
    const gb = await geoBoundaries(iso3, adm);
    if (!gb) {
      console.log(`${CC} ${adm}: none`);
      break;
    }
    const placed = [];
    gb.features.forEach((f, i) => {
      const centre = geoCentroid(f);
      const parent =
        parents.find((p) => geoContains(p.feature, centre))?.id ?? "";
      const id = `${level}-${i}`;
      if (write(cc, id, level, parent, f, DISTRICT, [f.properties.shapeName])) {
        placed.push({ id, feature: f });
      }
    });
    console.log(`${CC} ${adm}: ${placed.length}`);
    parents = placed;
  }
}

writeFileSync(
  new URL("README.md", outDir),
  `# Region maps

Generated by \`scripts/gen-region-maps.mjs\` — do not edit by hand.

- Level 1 (provinces): Natural Earth, public domain. https://www.naturalearthdata.com
- Levels 2–3 (districts): geoBoundaries (gbOpen), CC BY 3.0 IGO / CC BY 4.0.
  Runfola, D. et al. (2020) geoBoundaries: A global database of political
  administrative boundaries. PLoS ONE 15(4): e0231866.
  https://www.geoboundaries.org
`,
);

const body = Object.keys(index)
  .sort()
  .map(
    (cc) =>
      `  ${cc}: [\n${index[cc].map((e) => `    ${JSON.stringify(e)},`).join("\n")}\n  ],`,
  )
  .join("\n");
writeFileSync(
  new URL("../src/features/region/region-shapes.ts", import.meta.url),
  `import "server-only";

/**
 * Every region map in \`/public/icons/maps/regions/{cc}/{id}.svg\`, by country:
 * [id, level, parent id ("" at level 1 or when unplaced), width, height (XD px),
 * names joined by "|"]. Generated by scripts/gen-region-maps.mjs — do not edit
 * by hand. Server-only: it is large; matching is in region-map.ts.
 */
export type RegionShape = readonly [
  id: string,
  level: number,
  parent: string,
  w: number,
  h: number,
  names: string,
];

export const REGION_SHAPES: Readonly<Record<string, readonly RegionShape[]>> = {
${body}
};
`,
);
console.log(`${files} region maps written`);

import "server-only";
import { getLocale } from "next-intl/server";
import { listNameLanguages } from "@/features/language/api";
import { nameRows, type NameLanguage } from "@/features/language/names";
import { activeOperations, readAllPages, readOperation } from "@/lib/api/operations";
import { pickName } from "@/lib/i18n/localized";
import type { Coded } from "./mock-ai";
import { countryMap, resolveFlag, type GeoNode } from "./mock-geo";
import { findRegionMap } from "./region-map";
import {
  rdbCountryCurrencySchema,
  rdbCountrySchema,
  rdbRegionSchema,
  rdbUnitTypeSchema,
  divisionChip,
  type Division,
  type RdbCountry,
  type RdbRegion,
} from "./schema";

/**
 * Single place region data is read. Server-only.
 *
 * The selected system's geography, from its own operations
 * (`backend docs/project-data/from-backend/2026-10-30-rdb-screens.md` §4.2–§4.5):
 *
 *   region_type.list   the Administrative Divisions tab, and the level picker
 *   country.list       the countries, with their code, dial code and levels —
 *                      closed ones too (`includeDeleted`): they stay in the
 *                      tree, greyed and read-only (2026-11-08 closed-country note)
 *   region.list        per open country, every live region below it at any depth
 *
 * `region.list` rather than the console's mirrored `/units`: it is RDB's live
 * answer (the mirror catches up seconds after a change, §6), and it carries
 * `isoCode`, which the code chip shows.
 *
 * The screens were built on the mock tree (`mock-geo.ts`), so this answers
 * that shape. What RDB does not hold stays decoration: maps are our own
 * generated assets — a country's by code, a region's matched by ISO code or
 * name (`region-map.ts`) — the flag is our own asset by code (RDB's
 * `flagImageUrl` is a remote image the CSP would refuse), and a level-1
 * region's plate number has nowhere to live in RDB, so it is gone after a
 * reload.
 */
export async function loadGeography(): Promise<{
  countries: GeoNode[];
  divisions: Division[];
}> {
  const [typeRows, countryRows, locale, languages] = await Promise.all([
    readOperation("region_type.list"),
    readAllPages("country.list", { query: { includeDeleted: "true" } }),
    getLocale(),
    listNameLanguages(),
  ]);

  const divisions: Division[] = rdbUnitTypeSchema
    .array()
    .parse(typeRows)
    .filter((t) => t.status !== "INACTIVE")
    .map((t) => ({ key: t.key, code: divisionChip(t.key), name: pickName(t.name, locale) }));

  const countries = rdbCountrySchema.array().parse(countryRows);
  const [regionsByCountry, currencyByCountry] = await Promise.all([
    Promise.all(
      // A closed country has nothing open below it (closing goes bottom up),
      // and its region reads may be refused: nothing to ask for.
      countries.map(async (c) =>
        c.deletedAt
          ? []
          : rdbRegionSchema.array().parse(
              await readAllPages("region.list", {
                params: { unit_id: c.id },
                query: { status: "ACTIVE" },
              }),
            ),
      ),
    ),
    Promise.all(countries.map((c) => defaultCurrency(c.id, locale))),
  ]);

  return {
    divisions,
    countries: countries.map((c, i) =>
      toCountryNode(c, regionsByCountry[i], currencyByCountry[i], divisions, locale, languages),
    ),
  };
}

/**
 * Whether flags go to RDB (`media.upload`, answers 2026-10-31 §1): only once
 * RDB has deployed the operation, and only for someone holding `media:write`
 * (Root always does). Until then the drawers fall back to a flagcdn link and
 * hide the upload. A failed read of the operation list reads as "not yet" —
 * the screen still works without uploads.
 */
export async function canUploadFlags(myPermissions: string[]): Promise<boolean> {
  if (!myPermissions.includes("media:write")) return false;
  return (await activeOperations().catch(() => new Set<string>())).has("media.upload");
}

/**
 * Whether a closed country's sheet offers Reopen: only once RDB lists
 * `country.reopen` as `ACTIVE`. A failed read of the list reads as "not yet".
 */
export async function canReopenCountries(): Promise<boolean> {
  return (await activeOperations().catch(() => new Set<string>())).has("country.reopen");
}

/**
 * A country's currency: the default among its links (`country.currency.list`,
 * answers 2026-11-05 §1), as a picker option — `key` is RDB's currency id,
 * `code` its ISO code (`symbol`). A failed read is "none", not a broken page.
 */
async function defaultCurrency(countryId: string, locale: string): Promise<Coded> {
  try {
    const links = rdbCountryCurrencySchema
      .array()
      .parse(await readOperation("country.currency.list", { params: { id: countryId } }));
    const d = links.find((l) => l.isDefault)?.currency;
    return d ? { key: d.id, code: d.symbol, name: pickName(d.name, locale) } : NONE;
  } catch {
    return NONE;
  }
}

const NONE: Coded = { code: "", name: "" };

/** A country's main language as the picker shows it: the system's entry, else the bare code. */
function mainLanguageOf(code: string | null | undefined, languages: NameLanguage[]): Coded {
  if (!code) return NONE;
  const l = languages.find((x) => x.code === code);
  return { key: code, code: code.toUpperCase(), name: l?.label ?? code };
}

function toCountryNode(
  country: RdbCountry,
  regions: RdbRegion[],
  currency: Coded,
  divisions: Division[],
  locale: string,
  languages: NameLanguage[],
): GeoNode {
  const name = pickName(country.name, locale);
  const levels = [...(country.levels ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((l) => {
      const d = divisions.find((x) => x.key === l.regionType);
      return { key: l.regionType, code: d?.code ?? divisionChip(l.regionType), name: d?.name ?? l.regionType };
    });

  // Children by parent id; RDB lists every depth at once, in its own order.
  const byParent = new Map<string, RdbRegion[]>();
  for (const r of regions) {
    byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
  }
  // Each region's map is matched inside its parent's (a district inside its
  // province), so the parent's shape id is passed down.
  const childrenOf = (parentId: string, level: number, parentShapeId?: string): GeoNode[] =>
    (byParent.get(parentId) ?? []).map((r) => {
      const match = findRegionMap({
        countryCode: country.code,
        level,
        parentShapeId,
        isoCode: r.isoCode,
        names: Object.values(r.name).filter((n): n is string => !!n),
      });
      return {
        id: r.id,
        // `SY-DI` → `DI`: the country part is already on the country's row.
        code: r.isoCode?.split("-")[1],
        name: pickName(r.name, locale),
        names: r.name,
        updatedAt: r.updatedAt,
        regionType: r.regionType ?? undefined,
        map: match?.image,
        children: childrenOf(r.id, level + 1, match?.shapeId),
      };
    });

  return {
    id: country.id,
    code: country.code,
    name,
    flag: resolveFlag(country.code),
    map: countryMap(country.code),
    names: country.name,
    updatedAt: country.updatedAt,
    closed: !!country.deletedAt,
    details: {
      shortName: country.code,
      name,
      // One row per language the project lists, from the name RDB keeps.
      translations: nameRows(languages, country.name),
      // Shown by the system language it names; post code and time zone are not read yet.
      mainLanguage: mainLanguageOf(country.mainLanguage, languages),
      currency,
      phoneCode: country.dialCode ?? "",
      postCode: "",
      gmt: "",
      levels,
    },
    children: childrenOf(country.id, 1),
  };
}

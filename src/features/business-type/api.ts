import "server-only";
import { z } from "zod";
import { readAllPagesShared, readShared } from "@/lib/api/operations";
import { rdbCatalogItemSchema, type BusinessCountry, type BusinessKind, type BusinessType, type RdbCatalogItem } from "./schema";

/**
 * Single place business types are read. Server-only.
 *
 * RDB's catalogs through the operations route (`POST /v1/projects/{id}/operations/…`):
 *   business_type.list   Individual and Corporate, told apart by `group`
 *   work_type.list       Business Work Type
 *   country.list         the flags a type may be limited to (RDB's ids)
 */

/** An RDB catalog item in the screen's words. */
export function toBusinessType(item: RdbCatalogItem, kind: BusinessKind): BusinessType {
  return {
    id: item.key,
    kind,
    short_name: item.shortName ?? item.key.slice(0, 4).toUpperCase(),
    name: item.name,
    all_countries: !item.countries || item.countries === "all",
    countries: Array.isArray(item.countries) ? item.countries : [],
    status: item.status,
    updatedAt: item.updatedAt,
  };
}

export async function listBusinessTypes(): Promise<BusinessType[]> {
  const [business, work] = await Promise.all([readShared("business_type.list"), readShared("work_type.list")]);
  const kindOf = (group?: string): BusinessKind => (group === "corporate" ? "corporate" : "individual");
  return [
    ...z
      .array(rdbCatalogItemSchema)
      .parse(business)
      .map((i) => toBusinessType(i, kindOf(i.group))),
    ...z
      .array(rdbCatalogItemSchema)
      .parse(work)
      .map((i) => toBusinessType(i, "work")),
  ];
}

const rdbCountrySchema = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    name: z.record(z.string(), z.string()),
    deletedAt: z.string().nullable().optional(),
  })
  .loose();

/** The project's countries from RDB — the ids a type's `countries` holds. A closed one is shown grey. */
export async function listBusinessCountries(): Promise<BusinessCountry[]> {
  const rows = z.array(rdbCountrySchema).parse(await readAllPagesShared("country.list", { query: { includeDeleted: "true" } }));
  return rows.map((c) => ({ id: c.id, name: c.name, code: c.code?.toUpperCase(), closed: !!c.deletedAt }));
}

import { z } from "zod";

/*
 * A project's business types — the System Business Type screen, in three
 * kinds (its three tabs): who a person is to a business (Owner, Partner, …),
 * what a corporate place is (Office, Branch, …), and how a business works
 * with the system (Business Partner, Distributor, …).
 *
 * They are RDB's catalogs, read and written through the operations route
 * (2026-11-17-business-structure-page.md): Individual and Corporate are
 * `business_type.list` by `group`, Business Work Type is `work_type.list`.
 * An item is named by its permanent `key`.
 */

export const BUSINESS_KINDS = ["individual", "corporate", "work"] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

/** A name keyed by language code — every language the project lists. */
const nameSchema = z.record(z.string(), z.string());

/** One item as RDB lists it (camelCase, its own field names). */
export const rdbCatalogItemSchema = z
  .object({
    key: z.string(),
    shortName: z.string().optional(),
    name: nameSchema,
    countries: z.union([z.literal("all"), z.array(z.string())]).optional(),
    status: z.string().optional(),
    /** `business_type.list` only: `individual` or `corporate`. */
    group: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .loose();
export type RdbCatalogItem = z.infer<typeof rdbCatalogItemSchema>;

/** What the screen shows: RDB's item, in the screen's words. `id` is RDB's `key`. */
export type BusinessType = {
  id: string;
  kind: BusinessKind;
  /** 1–4 letters or digits — the chip in the list ("OWN"). */
  short_name: string;
  name: Record<string, string>;
  /** Available in every country of the project, or only in `countries` (RDB country ids). */
  all_countries: boolean;
  countries: string[];
  status?: string;
  updatedAt?: string;
};

/** 1–4 letters or digits. */
export const SHORT_NAME = /^[A-Za-z0-9]{1,4}$/;

/** What the panel sends: a new item (no `key`), or a change to one. */
export const businessTypeInputSchema = z.object({
  kind: z.enum(BUSINESS_KINDS),
  key: z.string().min(1).optional(),
  short_name: z.string().regex(SHORT_NAME),
  name: nameSchema,
  all_countries: z.boolean(),
  countries: z.array(z.string()).max(300),
  updatedAt: z.string().optional(),
});
export type BusinessTypeInput = z.infer<typeof businessTypeInputSchema>;

/** A country the panel's flag strip offers: RDB's own id. */
export type BusinessCountry = { id: string; name: Record<string, string>; code?: string; closed: boolean };

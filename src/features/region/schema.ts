import { z } from "zod";
import { localizedNameSchema } from "@/lib/i18n/localized";

/*
 * RDB's geography, as its operations answer it
 * (`backend docs/project-data/from-backend/2026-10-30-rdb-screens.md` §4.2–§4.5, §5). Only
 * what these screens read is required; everything else is left to `.loose()`
 * so a field RDB adds never fails the page.
 */

/** One level of a country's structure; position 1 is directly under the country. */
export const rdbLevelSchema = z.object({
  position: z.number().int(),
  regionType: z.string(),
  optional: z.boolean().optional(),
});

export const rdbCountrySchema = z
  .object({
    id: z.string(),
    name: localizedNameSchema,
    code: z.string(),
    dialCode: z.string().optional(),
    levels: z.array(rdbLevelSchema).optional(),
    /** Sent back as `expectedUpdatedAt` on an edit, exactly as read (answers 2026-11-05 §2). */
    updatedAt: z.string().optional(),
    /** Set while the country is closed: it is read-only, and only reopening works. */
    deletedAt: z.string().nullable().optional(),
    /** ISO 639-1, lower case (`ar`), or null when unset (answers 2026-11-05 §5, live 2026-11-07). */
    mainLanguage: z.string().nullable().optional(),
  })
  .loose();
export type RdbCountry = z.infer<typeof rdbCountrySchema>;

export const rdbRegionSchema = z
  .object({
    id: z.string(),
    countryId: z.string(),
    /** Its parent region, or the country at level 1 — never null. */
    parentId: z.string(),
    regionType: z.string().nullable().optional(),
    level: z.number().int().optional(),
    name: localizedNameSchema,
    isoCode: z.string().nullable().optional(),
    status: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .loose();
export type RdbRegion = z.infer<typeof rdbRegionSchema>;

/** One currency linked to a country (`country.currency.list`, not paged). The default has `isDefault`. */
export const rdbCountryCurrencySchema = z
  .object({
    isDefault: z.boolean().optional(),
    currency: z
      .object({ id: z.string(), symbol: z.string(), name: localizedNameSchema })
      .loose(),
  })
  .loose();

/** A region type (the Administrative Divisions tab): a permanent `key` and a name. */
export const rdbUnitTypeSchema = z
  .object({
    key: z.string(),
    // `en` and `ar`, plus any other language the project lists (2026-11-08 §2).
    name: localizedNameSchema,
    status: z.string().optional(),
  })
  .loose();
export type RdbUnitType = z.infer<typeof rdbUnitTypeSchema>;

/**
 * A region type as the screens use it: `code` is the short chip, `name` the
 * label in the current language, `key` what RDB is sent.
 */
export type Division = { key: string; code: string; name: string };

/** The short chip for a region type: its key's first four letters ("province" → "PROV"). */
export function divisionChip(key: string): string {
  return key.replace(/_/g, "").slice(0, 4).toUpperCase();
}

/** A typed division name → its permanent key ("Sub district" → "sub_district"). */
export function divisionKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/* ───────────────────────── What the forms send ───────────────────────── */

/** ISO 3166-1 alpha-2 — RDB takes two letters only (answers 2026-11-05 §2). */
export const COUNTRY_CODE = /^[A-Z]{2}$/;
const countryCode = z.string().regex(COUNTRY_CODE);
/** A currency is found by its ISO 4217 code, which RDB keeps in `symbol` (answers 2026-11-05 §1). */
export const CURRENCY_CODE = /^[A-Z]{3}$/;
/** RDB's `updatedAt`, returned untouched: an edit based on older data is refused. */
const expectedUpdatedAt = z.string().min(1).optional();
/** `+` and 1–4 digits. */
const dialCode = z.string().regex(/^\+\d{1,4}$/);
const nameText = z.string().trim().min(1).max(200);
/** 1–40 lowercase letters, digits or `_`. Permanent once created. */
const typeKey = z.string().regex(/^[a-z0-9_]{1,40}$/);

/** A language code as a name's key (`en`, `ckb`, `zh-Hant`). */
const languageKey = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

/**
 * A new name: every language the form filled, each 1–200 characters and never
 * empty (an empty row is left out). `en` and `ar` are required
 * (`2026-11-08-languages-screen-and-names.md` §2). Whether a language may be
 * used at all is RDB's to say: an `INACTIVE` one is `422` on `name.<code>`.
 */
export const newNameSchema = z
  .record(languageKey, nameText)
  .refine((n) => !!n.en && !!n.ar);

/** An edit's name: only the languages that changed; `null` removes one. `en` and `ar` can't be removed. */
export const nameChangesSchema = z
  .record(languageKey, nameText.nullable())
  .refine((n) => n.en !== null && n.ar !== null);

export const createCountrySchema = z.object({
  code: countryCode,
  name: newNameSchema,
  dialCode,
  /** Region-type keys, in order: the first is level 1. */
  levels: z.array(typeKey).max(10),
  /** RDB's id of the currency to make the country's default; left out = no change. */
  currencyId: z.string().min(1).optional(),
  /** Its main language, ISO 639-1 lower case — one of the system's languages; left out = none/no change. */
  mainLanguage: z.string().regex(/^[a-z]{2}$/).optional(),
});
export type CreateCountryInput = z.infer<typeof createCountrySchema>;

export const createRegionSchema = z.object({
  parentId: z.string().min(1),
  name: newNameSchema,
  regionType: typeKey.optional(),
  /** ISO 3166-2, e.g. `SY-DI`. */
  isoCode: z
    .string()
    .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/)
    .optional(),
});
export type CreateRegionInput = z.infer<typeof createRegionSchema>;

/**
 * Editing a saved country: what `country.update` takes (§4.3) — the name only
 * in the languages that changed (RDB keeps the rest) — plus the level order
 * (`country.levels.update`), only when it changed.
 */
export const updateCountrySchema = createCountrySchema.extend({
  id: z.string().min(1),
  name: nameChangesSchema.optional(),
  levelsChanged: z.boolean(),
  expectedUpdatedAt,
});
export type UpdateCountryInput = z.infer<typeof updateCountrySchema>;

/**
 * Editing a saved region: what `region.update` takes (§4.5). `null` clears the
 * ISO code; `regionType` only when it changed (allowed while nothing is below).
 */
export const updateRegionSchema = z.object({
  id: z.string().min(1),
  regionType: typeKey.optional(),
  expectedUpdatedAt,
  /** Only the languages that changed; left out when none did. */
  name: nameChangesSchema.optional(),
  isoCode: z
    .string()
    .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/)
    .nullable(),
});
export type UpdateRegionInput = z.infer<typeof updateRegionSchema>;

/* ───────────────────── Flags: RDB's media.upload (answers §1) ───────────────────── */

/** The types RDB accepts — it reads the real type from the file itself. */
export const FLAG_TYPES = ["image/svg+xml", "image/png", "image/webp"] as const;
/** At most 256 KB once decoded. */
export const MAX_FLAG_BYTES = 256 * 1024;

/** Bytes a standard, padded base64 string decodes to. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * A flag file on its way to RDB: standard base64 WITH padding, no `data:`
 * prefix, no base64url. Checked in the browser before sending (so the person
 * hears about it at once) and again here.
 */
export const flagFileSchema = z.object({
  contentType: z.enum(FLAG_TYPES),
  data: z
    .string()
    .min(4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((d) => base64Bytes(d) <= MAX_FLAG_BYTES),
});
export type FlagFile = z.infer<typeof flagFileSchema>;

/** Adding a currency the system lacks, so a country can be linked to it. */
export const createCurrencySchema = z.object({
  symbol: z.string().regex(CURRENCY_CODE),
  name: newNameSchema,
});
export type CreateCurrencyInput = z.infer<typeof createCurrencySchema>;

/** Closing — or reopening — a country or region: RDB asks for a reason, at most 500 characters. */
export const closeUnitSchema = z.object({
  kind: z.enum(["country", "region"]),
  id: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});
export type CloseUnitInput = z.infer<typeof closeUnitSchema>;

export const createDivisionSchema = z.object({
  key: typeKey,
  name: newNameSchema,
});
export type CreateDivisionInput = z.infer<typeof createDivisionSchema>;

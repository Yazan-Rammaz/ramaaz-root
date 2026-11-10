import { z } from "zod";
import { localizedNameSchema } from "@/lib/i18n/localized";

/*
 * A project's languages, from its own `language.list` and `language.coverage`
 * operations (`backend docs/project-data/from-backend/2026-11-08-languages-screen-and-names.md`).
 * Only what the screens read is required; the rest is left to `.loose()` so a
 * field RDB adds never fails the page.
 */

export const LANGUAGE_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE"] as const;
export type LanguageStatus = (typeof LANGUAGE_STATUSES)[number];

/**
 * One language. `code` is a BCP 47 tag in canonical casing (`tr`, `ckb`,
 * `zh-Hant`) and never changes. `en` and `ar` are `required`: always
 * `ACTIVE`, direction and fallback fixed.
 */
export const languageSchema = z
  .object({
    code: z.string(),
    /** `{ en, ar }` only — a language's own name is never in more languages. */
    name: localizedNameSchema,
    nativeName: z.string(),
    direction: z.enum(["ltr", "rtl"]).catch("ltr"),
    status: z.enum(LANGUAGE_STATUSES).catch("DRAFT"),
    required: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    /** `en` or `ar`: shown where a text is missing, and the language of its system messages. */
    fallback: z.string().nullable().optional(),
    sortOrder: z.number().optional(),
    /** Sent back as `expectedUpdatedAt` on an edit, exactly as read. */
    updatedAt: z.string().optional(),
  })
  .loose();
export type Language = z.infer<typeof languageSchema>;

const kindCount = z.object({ total: z.number(), missing: z.number() }).loose();

/** How many names still have no text, per language and per kind (`language.coverage`). */
export const coverageSchema = z.object({
  languages: z.array(
    z
      .object({
        code: z.string(),
        status: z.string().optional(),
        total: z.number(),
        missing: z.number(),
        /** Rounded down, so 100 means complete. */
        percent: z.number(),
        kinds: z.record(z.string(), kindCount).optional(),
      })
      .loose(),
  ),
});
export type Coverage = z.infer<typeof coverageSchema>;
export type LanguageCoverage = Coverage["languages"][number];

/* ───────────────────────── What the screen sends ───────────────────────── */

/** BCP 47 in canonical casing: `tr`, `ku`, `ckb`, `zh-Hant`, `pt-BR`. */
export const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;
const nameText = z.string().trim().min(1).max(200);
const fallback = z.enum(["en", "ar"]);
const sortOrder = z.number().int().min(0).max(10000);
const direction = z.enum(["ltr", "rtl"]);

export const createLanguageSchema = z.object({
  code: z.string().regex(LANGUAGE_CODE),
  nameEn: nameText,
  nameAr: nameText,
  nativeName: z.string().trim().min(1).max(100),
  direction,
  fallback: fallback.optional(),
  sortOrder: sortOrder.optional(),
});
export type CreateLanguageInput = z.infer<typeof createLanguageSchema>;

/** Only what changed; at least one field besides `expectedUpdatedAt` (else RDB answers `422`). */
export const updateLanguageSchema = z
  .object({
    code: z.string().min(1),
    nameEn: nameText.optional(),
    nameAr: nameText.optional(),
    nativeName: z.string().trim().min(1).max(100).optional(),
    direction: direction.optional(),
    fallback: fallback.optional(),
    sortOrder: sortOrder.optional(),
    expectedUpdatedAt: z.string().min(1).optional(),
  })
  .refine((u) =>
    [u.nameEn, u.nameAr, u.nativeName, u.direction, u.fallback, u.sortOrder].some((v) => v !== undefined),
  );
export type UpdateLanguageInput = z.infer<typeof updateLanguageSchema>;

/** A status change. The reason is the console's (kept in its journal), never in the body. */
export const languageStatusSchema = z.object({
  code: z.string().min(1),
  status: z.enum(LANGUAGE_STATUSES),
  reason: z.string().trim().min(1).max(500),
});
export type LanguageStatusInput = z.infer<typeof languageStatusSchema>;

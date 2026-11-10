import { z } from "zod";
import { localizedNameSchema, type LocalizedName } from "@/lib/i18n/localized";
import { CURRENCY_CODE, nameChangesSchema } from "@/features/region/schema";

/**
 * RDB's Currency, as `currency.list` / `currency.get` answer it (rdb-screens
 * §5). Only what the screen shows is required; the payment-provider blocks are
 * left to `.loose()`.
 */
export const rdbCurrencySchema = z
  .object({
    id: z.string(),
    /** Every language the project lists, `en` and `ar` first (2026-11-08 §2). */
    name: localizedNameSchema,
    /** The ISO 4217 code (answers 2026-11-05 §1) — a few old ones hold something else. */
    symbol: z.string(),
    isActive: z.boolean().optional(),
    /** Sent back as `expectedUpdatedAt` on an edit, exactly as read (2026-11-08). */
    updatedAt: z.string().optional(),
  })
  .loose();
export type RdbCurrency = z.infer<typeof rdbCurrencySchema>;

/** The category filters shown in the header strip (XD Group 16347). */
export const currencyCategorySchema = z.enum([
  "cash",
  "crypto",
  "gold",
  "silver",
]);
export type CurrencyCategory = z.infer<typeof currencyCategorySchema>;

/**
 * A system currency as the list shows it: the code in the leading box (fiat
 * has one, commodities like Gold/Silver show an icon instead) and the name in
 * the interface language. `names`, `isActive` and `updatedAt` are what Edit
 * starts from and sends back.
 */
export type Currency = {
  id: string;
  /** Which header filter this row belongs to. */
  category: CurrencyCategory;
  /** e.g. "USD" — RDB's `symbol`. */
  code?: string;
  /** e.g. "currencies/gold" — a colourful icon shown in the box instead of a code. */
  icon?: string;
  name: string;
  names?: LocalizedName;
  isActive?: boolean;
  updatedAt?: string;
};

/* ───────────────────────── What Edit sends ───────────────────────── */

/**
 * `currency.update` (rdb-screens §4.1): only what changed, at least one field
 * besides `expectedUpdatedAt` (else RDB answers `422`). The code is three
 * upper-case letters; the name only in the languages that changed.
 */
export const updateCurrencySchema = z
  .object({
    id: z.string().min(1),
    symbol: z.string().regex(CURRENCY_CODE).optional(),
    name: nameChangesSchema.optional(),
    isActive: z.boolean().optional(),
    expectedUpdatedAt: z.string().min(1).optional(),
  })
  .refine((u) => u.symbol !== undefined || u.name !== undefined || u.isActive !== undefined);
export type UpdateCurrencyInput = z.infer<typeof updateCurrencySchema>;

import { z } from "zod";

/**
 * A system currency: an optional short code (shown Medium before the name — fiat
 * has one, commodities like Gold/Silver don't) and the display name. Shape
 * mirrors the intended NestJS DTO so swapping the mock in api.ts for the real
 * endpoint needs no UI change.
 */
/** The category filters shown in the header strip (XD Group 16347). */
export const currencyCategorySchema = z.enum([
  "cash",
  "crypto",
  "gold",
  "silver",
]);
export type CurrencyCategory = z.infer<typeof currencyCategorySchema>;

export const currencySchema = z.object({
  id: z.string(),
  category: currencyCategorySchema, // which header filter this row belongs to
  code: z.string().optional(), // e.g. "USD" — shown as text in the leading box (fiat)
  icon: z.string().optional(), // e.g. "currencies/gold" — colorful icon shown in the box instead of a code
  name: z.string(), // e.g. "American Dollars" — shown in the card
});

export type Currency = z.infer<typeof currencySchema>;

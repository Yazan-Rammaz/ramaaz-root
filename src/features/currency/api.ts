import "server-only";
import { getLocale } from "next-intl/server";
import { activeOperations, readAllPages } from "@/lib/api/operations";
import { pickName } from "@/lib/i18n/localized";
import { rdbCurrencySchema, type Currency, type RdbCurrency } from "./schema";

/**
 * Single place currency endpoints are read. Server-only.
 *
 * Currencies are PROJECT data, read through the selected system's
 * `currency.list` operation (`backend docs/project-data/from-backend/2026-10-30-rdb-screens.md`
 * §4.1) — every page of it, live currencies only (removed ones are left out by
 * RDB unless asked for).
 *
 * RDB has no CATEGORY, and the header is a four-tab filter (cash / crypto /
 * gold / silver). Decided with the owner: every currency sits under "cash" and
 * the other three tabs stay empty until there is something to put in them.
 * The leading box shows RDB's `symbol`; `icon` stays ours (the metals' assets),
 * so nothing from RDB uses it.
 */
export async function listCurrencies(): Promise<Currency[]> {
  const [rows, locale] = await Promise.all([readAllPages("currency.list"), getLocale()]);
  return rdbCurrencySchema.array().parse(rows).map((c) => toCurrency(c, locale));
}

/** RDB's Currency → the row the list shows (and Edit starts from). */
export function toCurrency(c: RdbCurrency, locale: string): Currency {
  return {
    id: c.id,
    category: "cash",
    code: c.symbol,
    name: pickName(c.name, locale),
    names: c.name,
    isActive: c.isActive,
    updatedAt: c.updatedAt,
  };
}

/**
 * Whether the list offers Edit: RDB lists `currency.update` as `ACTIVE` and
 * the person holds `currencies:write` (project only; Root always does). A
 * failed read of the operation list reads as "not yet".
 */
export async function canEditCurrencies(myPermissions: string[]): Promise<boolean> {
  if (!myPermissions.includes("currencies:write")) return false;
  return (await activeOperations().catch(() => new Set<string>())).has("currency.update");
}

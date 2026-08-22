import "server-only";
import { currencySchema, type Currency } from "./schema";

/**
 * Single place currency endpoints are read. Server-only.
 *
 * Currencies are PROJECT data — they live in the SELECTED system's own
 * backend (rdb, trydos, …), not in the root backend. MOCK for now; when the
 * project backends expose currencies, swap for the selected-system call and
 * keep the schema.parse boundary exactly as-is:
 *   const data = await backendFetch.get<unknown>("/currencies");
 *   return currencySchema.array().parse(data);
 * (import { backendFetch } from "@/lib/api/backend"). Nothing else changes.
 */
const MOCK_CURRENCIES: unknown[] = [
  { id: "usd", category: "cash", code: "USD", name: "American Dollars" },
  { id: "ytl", category: "cash", code: "YTL", name: "Turkish Lira" },
  { id: "syp", category: "cash", code: "SYP", name: "Syrian Pounds" },
  { id: "iqd", category: "cash", code: "IQD", name: "Iraqi Dinar" },
  { id: "lbp", category: "cash", code: "LBP", name: "Lebanese Pound" },
  { id: "usdt", category: "crypto", icon: "currencies/usdt", name: "USDT, TRON, TRC20" },
  { id: "gold", category: "gold", icon: "currencies/gold", name: "Gold 24" },
  { id: "silver", category: "silver", icon: "currencies/silver", name: "Silver" },
];

export async function listCurrencies(): Promise<Currency[]> {
  return currencySchema.array().parse(MOCK_CURRENCIES);
}

export async function getCurrency(id: string): Promise<Currency> {
  const found = MOCK_CURRENCIES.find(
    (c): c is { id: string } =>
      typeof c === "object" && c !== null && (c as { id?: unknown }).id === id,
  );
  return currencySchema.parse(found);
}

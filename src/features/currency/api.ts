import "server-only";
import { currencySchema, type Currency } from "./schema";

/**
 * Single place currency endpoints are read. Server-only.
 *
 * Currencies are PROJECT data — scoped to the system selected on /systems, and
 * served by the root backend on that project's behalf (it holds the
 * credentials; we never call a project directly). STILL MOCK, and the swap is:
 *
 *   const data = await backendFetch.get<unknown>("/connection/manifest");
 *   return currencySchema.array().parse(data.currencies);
 *
 * (import { backendFetch } from "@/lib/api/backend" — it prefixes
 * `/v1/projects/{selected}` for you.) Keep the schema.parse boundary exactly.
 *
 * ⚠️ NOT SWAPPED YET, and not for want of an endpoint. We do not know what
 * `manifest.currencies` contains — a list of codes, or objects, and whether
 * anything on it carries a CATEGORY. The category is load-bearing here: the
 * header is a four-tab filter (cash/crypto/gold/silver) and the mock below
 * invents it. If the backend sends no category, either we derive it from
 * something or the tabs go — a design decision, not a mapping.
 *
 * `icon` is ours either way: an asset we ship for the metals, never a backend
 * field. Asked in `backend docs/frontend-project-data-needs.md`.
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

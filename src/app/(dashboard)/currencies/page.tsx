import { listCurrencies } from "@/features/currency/api";
import { CurrencyList } from "@/features/currency/components/CurrencyList";

/**
 * System Currencies — the currency list. Renders inside the (dashboard) shell;
 * the layout provides the <main> scroll region and the requireSession() gate, so
 * this page stays thin.
 */
export default async function CurrenciesPage() {
  const currencies = await listCurrencies();
  return <CurrencyList items={currencies} />;
}

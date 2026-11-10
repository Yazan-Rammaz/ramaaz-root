import { redirect } from "next/navigation";
import { canEditCurrencies, listCurrencies } from "@/features/currency/api";
import { CurrencyList } from "@/features/currency/components/CurrencyList";
import { listNameLanguages } from "@/features/language/api";
import { getSelectedSystem } from "@/lib/api/backend";

/**
 * System Currencies — the selected system's currency list, editable where RDB
 * allows it. Renders inside the (dashboard) shell; the layout provides the
 * <main> scroll region and the requireSession() gate, so this page stays thin.
 * Nothing selected (or no longer selectable) → back to the systems list, which
 * is where one is picked.
 */
export default async function CurrenciesPage() {
  const system = await getSelectedSystem();
  if (!system) redirect("/systems");
  const [currencies, languages, editable] = await Promise.all([
    listCurrencies(),
    listNameLanguages(),
    canEditCurrencies(system.myPermissions),
  ]);
  return <CurrencyList items={currencies} languages={languages} editable={editable} />;
}

import { redirect } from "next/navigation";
import { listCurrencies } from "@/features/currency/api";
import { listNameLanguages } from "@/features/language/api";
import { canReopenCountries, canUploadFlags, loadGeography } from "@/features/region/api";
import { RegionList } from "@/features/region/components/RegionList";
import { getSelectedSystem } from "@/lib/api/backend";

/**
 * System Geographic Regions — the selected system's countries, the regions in
 * them, and its region types. Renders inside the (dashboard) shell; the layout
 * provides the <main> scroll region and the requireSession() gate, so this
 * page stays thin. Nothing selected → back to the systems list.
 */
export default async function RegionsPage() {
  const system = await getSelectedSystem();
  if (!system) redirect("/systems");
  const [geography, languages, currencies, flagUploads, reopenable] = await Promise.all([
    loadGeography(),
    listNameLanguages(),
    // The currency picker only; the page still opens if the list fails.
    listCurrencies().catch(() => []),
    canUploadFlags(system.myPermissions),
    canReopenCountries(),
  ]);
  return (
    <RegionList
      countries={geography.countries}
      divisions={geography.divisions}
      languages={languages}
      // A country's main language is one of the system's languages; RDB takes
      // ISO 639-1 there, so only 2-letter codes (not `ckb` or `zh-Hant`).
      languageOptions={languages
        .filter((l) => l.status !== "INACTIVE" && /^[a-z]{2}$/.test(l.code))
        .map((l) => ({ key: l.code, code: l.chip, name: l.label }))}
      currencyOptions={currencies.map((c) => ({ key: c.id, code: c.code ?? "", name: c.name }))}
      flagUploads={flagUploads}
      reopenable={reopenable}
    />
  );
}

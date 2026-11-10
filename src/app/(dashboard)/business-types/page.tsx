import { redirect } from "next/navigation";
import { listBusinessTypes } from "@/features/business-type/api";
import { BusinessTypeList } from "@/features/business-type/components/BusinessTypeList";
import { listNameLanguages } from "@/features/language/api";
import type { NameLanguage } from "@/features/language/names";
import { listRoleCountries } from "@/features/role/api";
import { getSelectedSystem } from "@/lib/api/backend";

/** Without the project's list, the name still has its two required languages. */
const FALLBACK_LANGUAGES: NameLanguage[] = [
  { code: "en", chip: "EN", label: "English", direction: "ltr", status: "ACTIVE", required: true },
  { code: "ar", chip: "AR", label: "العربية", direction: "rtl", status: "ACTIVE", required: true },
];

/**
 * System Business Type — the selected project's business types, in three
 * tabs. Renders inside the (dashboard) shell; the layout provides the <main>
 * scroll region and the requireSession() gate, so this page stays thin.
 * Nothing selected → back to the systems list.
 *
 * The types are mocked until the backend has them (`features/business-type/api.ts`);
 * the countries and languages are the project's real ones, and the page still
 * opens if either can't be read.
 */
export default async function BusinessTypesPage() {
  if (!(await getSelectedSystem())) redirect("/systems");
  const [items, countries, languages] = await Promise.all([
    listBusinessTypes(),
    listRoleCountries().catch(() => []),
    listNameLanguages().catch(() => FALLBACK_LANGUAGES),
  ]);
  return <BusinessTypeList items={items} countries={countries} languages={languages} />;
}

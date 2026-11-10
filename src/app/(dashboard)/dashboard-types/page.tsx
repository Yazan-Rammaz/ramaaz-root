import { redirect } from "next/navigation";
import { listDashboardTypes } from "@/features/dashboard-type/api";
import { DashboardTypeList } from "@/features/dashboard-type/components/DashboardTypeList";
import { listNameLanguages } from "@/features/language/api";
import type { NameLanguage } from "@/features/language/names";
import { listRoleCountries } from "@/features/role/api";
import { getSelectedSystem } from "@/lib/api/backend";

/** Without the project's list, a name still has its two required languages. */
const FALLBACK_LANGUAGES: NameLanguage[] = [
  { code: "en", chip: "EN", label: "English", direction: "ltr", status: "ACTIVE", required: true },
  { code: "ar", chip: "AR", label: "العربية", direction: "rtl", status: "ACTIVE", required: true },
];

/**
 * System Dashboards Type — the selected project's dashboard types. Renders
 * inside the (dashboard) shell; the layout provides the <main> scroll region
 * and the requireSession() gate, so this page stays thin. Nothing selected →
 * back to the systems list.
 *
 * The types are mocked until the backend has them (`features/dashboard-type/api.ts`);
 * the flags and languages are the project's real ones, and the page still
 * opens if either can't be read.
 */
export default async function DashboardTypesPage() {
  if (!(await getSelectedSystem())) redirect("/systems");
  const [items, countries, languages] = await Promise.all([
    listDashboardTypes(),
    listRoleCountries().catch(() => []),
    listNameLanguages().catch(() => FALLBACK_LANGUAGES),
  ]);
  return (
    <DashboardTypeList
      items={items}
      countries={countries.flatMap((c) => (c.code ? [c.code] : []))}
      languages={languages}
    />
  );
}

import { redirect } from "next/navigation";
import { languageAccess, languageCoverage, listLanguages } from "@/features/language/api";
import { LanguageList } from "@/features/language/components/LanguageList";
import { getSelectedSystem } from "@/lib/api/backend";

/**
 * System Languages — the selected project's languages, their coverage, and
 * (with `languages:write`) adding, editing and activating them. Renders inside
 * the (dashboard) shell; the layout provides the <main> scroll region and the
 * requireSession() gate, so this page stays thin. Nothing selected → back to
 * the systems list.
 */
export default async function LanguagesPage() {
  const system = await getSelectedSystem();
  if (!system) redirect("/systems");
  const [languages, coverage, access] = await Promise.all([
    listLanguages(),
    languageCoverage(),
    languageAccess(system.myPermissions),
  ]);
  return <LanguageList items={languages} coverage={coverage} access={access} />;
}

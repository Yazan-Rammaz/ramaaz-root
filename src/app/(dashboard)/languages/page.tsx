import { listLanguages } from "@/features/language/api";
import { LanguageList } from "@/features/language/components/LanguageList";

/**
 * System Languages — the language list. Renders inside the (dashboard) shell;
 * the layout provides the <main> scroll region and the requireSession() gate, so
 * this page stays thin.
 */
export default async function LanguagesPage() {
  const languages = await listLanguages();
  return <LanguageList items={languages} />;
}

import "server-only";
import { cache } from "react";
import { activeOperations, readOperation } from "@/lib/api/operations";
import { chipOf, type NameLanguage } from "./names";
import { coverageSchema, languageSchema, type Coverage, type Language } from "./schema";

/**
 * Single place a project's languages are read. Server-only.
 *
 * They belong to the SELECTED project and come from its own operations
 * (`backend docs/project-data/from-backend/2026-11-08-languages-screen-and-names.md`):
 *
 *   language.list       every language, every status, already in display order
 *   language.coverage   how many names still have no text, per language
 *
 * Read again on every request, so selecting another system shows its own
 * languages. The fixed `en / ar / tr / ku` list that stood here is gone.
 */
export const listLanguages = cache(async (): Promise<Language[]> => {
  return languageSchema.array().parse(await readOperation("language.list"));
});

/**
 * The languages as a name form needs them — every status: the form decides
 * which get a row (`rowLanguages`). Labelled with each language's name in
 * itself.
 */
export async function listNameLanguages(): Promise<NameLanguage[]> {
  return (await listLanguages()).map((l) => ({
    code: l.code,
    chip: chipOf(l.code),
    label: l.nativeName,
    direction: l.direction,
    status: l.status,
    required: l.required ?? (l.code === "en" || l.code === "ar"),
  }));
}

/**
 * Coverage across the whole project, or null when it can't be read. A caller
 * whose reach is below the project gets `404 NOT_FOUND` — this console is
 * Root's, which always reaches it, but a failed read must still leave the
 * screen working, and the activation dialog then says coverage could not be
 * checked rather than showing 100.
 */
export async function languageCoverage(): Promise<Coverage | null> {
  try {
    return coverageSchema.parse(await readOperation("language.coverage"));
  } catch {
    return null;
  }
}

/**
 * Which language commands this person can use: the operation must be `ACTIVE`
 * in the project and they must hold `languages:write` (granted at the project
 * only; Root holds it). A failed read of the operation list is "none".
 */
export async function languageAccess(myPermissions: string[]) {
  const ops = myPermissions.includes("languages:write")
    ? await activeOperations().catch(() => new Set<string>())
    : new Set<string>();
  return {
    create: ops.has("language.create"),
    update: ops.has("language.update"),
    status: ops.has("language.status.update"),
  };
}
export type LanguageAccess = Awaited<ReturnType<typeof languageAccess>>;

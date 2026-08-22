import "server-only";
import { languageSchema, type Language } from "./schema";

/**
 * Single place language endpoints are read. Server-only.
 *
 * Languages are PROJECT data — they live in the SELECTED system's own
 * backend (rdb, trydos, …), not in the root backend. MOCK for now; when the
 * project backends expose languages, swap for the selected-system call and
 * keep the schema.parse boundary exactly as-is:
 *   const data = await backendFetch.get<unknown>("/languages");
 *   return languageSchema.array().parse(data);
 * (import { backendFetch } from "@/lib/api/backend"). Nothing else changes.
 */
const MOCK_LANGUAGES: unknown[] = [
  { id: "en", code: "EN", name: "English" },
  { id: "ar", code: "AR", name: "Arabic" },
  { id: "tr", code: "TR", name: "Turkish" },
  { id: "ku", code: "KU", name: "Kurdish" },
];

export async function listLanguages(): Promise<Language[]> {
  return languageSchema.array().parse(MOCK_LANGUAGES);
}

export async function getLanguage(id: string): Promise<Language> {
  const found = MOCK_LANGUAGES.find(
    (l): l is { id: string } =>
      typeof l === "object" && l !== null && (l as { id?: unknown }).id === id,
  );
  return languageSchema.parse(found);
}

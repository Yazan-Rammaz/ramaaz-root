import "server-only";
import { languageSchema, type Language } from "./schema";

/**
 * Single place language endpoints are read. Server-only.
 *
 * Languages are PROJECT data — scoped to the system selected on /systems, and
 * served by the root backend on that project's behalf.
 *
 * ⚠️ THERE IS NO ENDPOINT. Not "not wired yet" — it does not exist on the
 * backend at all, confirmed round 2 §2, which lists what does: the connection
 * manifest, org-units, unit-types and employees. Languages is not among them.
 *
 * We have asked for `GET /v1/projects/{id}/languages` (a read; this page has no
 * create or edit), and flagged that if it turns out to be a large piece of work
 * we would rather leave this mocked than block on it. Until that answer lands
 * this mock is the screen, and that is a deliberate hold rather than an
 * oversight. See `backend docs/frontend-project-data-needs.md`.
 *
 * When it exists, the swap keeps the schema.parse boundary exactly:
 *   const data = await backendFetch.get<unknown>("/languages");
 *   return languageSchema.array().parse(data);
 * (import { backendFetch } from "@/lib/api/backend" — it prefixes
 * `/v1/projects/{selected}` for you.)
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

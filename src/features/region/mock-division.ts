/**
 * The shape of the Add-Administrative-Division drawer's AI sheet. A division
 * is a region type (Province, District, …) — the list comes from RDB's
 * `region_type.list` and the translations from the real AI pass (`ai.ts`);
 * the default types and canned translations that used to live here are gone.
 */
export type DivisionTranslation = { code: string; name: string };
export type DivisionDraft = {
  shortName: string;
  name: string;
  translations: DivisionTranslation[];
};

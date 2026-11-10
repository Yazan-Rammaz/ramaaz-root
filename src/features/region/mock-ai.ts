/**
 * The shapes of the region drawers' AI sheets. The sheets themselves now come
 * from the real AI pass (`ai.ts`, OpenAI) with an empty fallback; the canned
 * Turkiye/Syria answers that used to live here are gone. The file keeps its
 * old name only so the drawers' imports stay put.
 */
export type Translation = { code: string; name: string };
/** `key`, when present, is the RDB region-type key behind a level. */
export type Coded = { code: string; name: string; key?: string };

export type CountryDraft = {
  shortName: string;
  name: string;
  /** One row per system language (`listLanguages`). */
  translations: Translation[];
  mainLanguage: Coded;
  currency: Coded;
  phoneCode: string;
  postCode: string;
  gmt: string;
  levels: Coded[];
};

/**
 * The AI sheet for a sub-level (province / district / …): the name across the
 * system languages, plus the general info it inherits from its country.
 */
export type SubLevelDraft = {
  shortName: string;
  /** The second chip — a province's plate number (34, 06, …); empty if none. */
  plate: string;
  name: string;
  translations: Translation[];
  phoneCode: string;
  postCode: string;
  gmt: string;
};

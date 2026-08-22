/**
 * Mock "AI" enrichment for the Add-Country drawer. In the real app this is a
 * backend/LLM call; here it returns canned data so the generate/load animations
 * have something to reveal. Only Turkiye is modelled (per the XD); anything else
 * returns a neutral shell.
 */
export type Translation = { code: string; name: string };
export type Coded = { code: string; name: string };

/** The system languages every translation list covers, in display order —
 *  the single source of truth for how many placeholder rows to shimmer
 *  before a draft exists. Add a language here (and to every draft below) and
 *  the UI picks it up; nothing elsewhere needs a matching hardcoded count. */
export const SYSTEM_LANGUAGES = ["EN", "AR", "TR", "KU"] as const;

export type CountryDraft = {
  shortName: string;
  name: string;
  translations: Translation[];
  mainLanguage: Coded;
  currency: Coded;
  phoneCode: string;
  postCode: string;
  gmt: string;
  levels: Coded[];
};

const TURKIYE: Omit<CountryDraft, "shortName" | "name"> = {
  translations: [
    { code: "EN", name: "Turkiye" },
    { code: "AR", name: "تركيا" },
    { code: "TR", name: "Turkiye" },
    { code: "KU", name: "Torki" },
  ],
  mainLanguage: { code: "TR", name: "Turkish" },
  currency: { code: "YTL", name: "Turkish Lira" },
  phoneCode: "+90",
  postCode: "No",
  gmt: "+3",
  levels: [
    { code: "PROV", name: "Province / Il" },
    { code: "DIST", name: "District / Ilce" },
    { code: "NBHD", name: "Neighborhood / Mahale" },
  ],
};

const SYRIA: Omit<CountryDraft, "shortName" | "name"> = {
  translations: [
    { code: "EN", name: "Syria" },
    { code: "AR", name: "سوريا" },
    { code: "TR", name: "Suriye" },
    { code: "KU", name: "Sûriye" },
  ],
  mainLanguage: { code: "AR", name: "Arabic" },
  currency: { code: "SYP", name: "Syrian Pound" },
  phoneCode: "+963",
  postCode: "No",
  gmt: "+3",
  levels: [
    { code: "GOV", name: "Governorate / Muhafazah" },
    { code: "DIST", name: "District / Mantiqah" },
    { code: "SDIST", name: "Sub-district / Nahiyah" },
  ],
};

/** Resolve enrichment for the given short name / name (mock: a couple of
 *  recognized countries; anything else returns a neutral, empty shell —
 *  never pre-seeded as a static row, only generated on demand). */
export function generateCountry(shortName: string, name: string): CountryDraft {
  const q = shortName + name;
  const base = /tr|turk/i.test(q)
    ? TURKIYE
    : /sy|syria|suri/i.test(q)
      ? SYRIA
      : {
          translations: [],
          mainLanguage: { code: "", name: "" },
          currency: { code: "", name: "" },
          phoneCode: "",
          postCode: "",
          gmt: "",
          levels: [],
        };
  return { shortName, name, ...base };
}

/**
 * The AI sheet for a sub-level (province / district / …). Simpler than a
 * country: name translations across the system languages + general info,
 * no currency / main-language / nested levels.
 */
export type SubLevelDraft = {
  shortName: string;
  name: string;
  translations: Translation[];
  phoneCode: string;
  postCode: string;
  gmt: string;
};

/**
 * Mock enrichment for a sub-level. Inherits the country's phone/GMT (a
 * province shares its country's dial code); the name transliterates across
 * the system languages (mock: same spelling when unknown).
 */
export function generateSubLevel(
  shortName: string,
  name: string,
  country?: CountryDraft,
): SubLevelDraft {
  return {
    shortName,
    name,
    translations: [
      { code: "EN", name },
      { code: "AR", name },
      { code: "TR", name },
      { code: "KU", name },
    ],
    phoneCode: country?.phoneCode ?? "",
    postCode: "No",
    gmt: country?.gmt ?? "",
  };
}

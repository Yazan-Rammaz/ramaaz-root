/**
 * Mock "AI" enrichment for the Add-Administrative-Division drawer. A division is
 * a type of geographic level (Province, District, Neighborhood, …). Entering the
 * name yields its translations across the system languages.
 */
export type DivisionTranslation = { code: string; name: string };
export type DivisionDraft = {
  shortName: string;
  name: string;
  translations: DivisionTranslation[];
};

/**
 * The system's default division types, in the XD order. They seed the
 * Administrative Divisions tab and are the options offered by the
 * Add-Country level dropdowns. "ST" repeats (State / Street) per the design,
 * so list keys must use the name, not the code.
 */
export const DIVISION_TYPES: { code: string; name: string }[] = [
  { code: "CTRY", name: "Country" },
  { code: "ST", name: "State" },
  { code: "PROV", name: "Province" },
  { code: "GOV", name: "Governorate" },
  { code: "CO", name: "County" },
  { code: "DIST", name: "District" },
  { code: "VIL", name: "Village" },
  { code: "CTY", name: "City" },
  { code: "ST", name: "Street" },
  { code: "RD", name: "Road" },
  { code: "NBHD", name: "Neighborhood" },
];

const TRANSLATIONS: Record<string, DivisionTranslation[]> = {
  country: [
    { code: "AR", name: "دولة" },
    { code: "TR", name: "Ulke" },
    { code: "KU", name: "Welat" },
  ],
  state: [
    { code: "AR", name: "ولاية" },
    { code: "TR", name: "Eyalet" },
    { code: "KU", name: "Dewlet" },
  ],
  province: [
    { code: "AR", name: "محافظة" },
    { code: "TR", name: "Il" },
    { code: "KU", name: "Parêzge" },
  ],
  district: [
    { code: "AR", name: "قضاء" },
    { code: "TR", name: "Ilce" },
    { code: "KU", name: "Navçe" },
  ],
  neighborhood: [
    { code: "AR", name: "حي" },
    { code: "TR", name: "Mahale" },
    { code: "KU", name: "Taxe" },
  ],
  city: [
    { code: "AR", name: "مدينة" },
    { code: "TR", name: "Sehir" },
    { code: "KU", name: "Bajar" },
  ],
  governorate: [
    { code: "AR", name: "محافظة" },
    { code: "TR", name: "Vilayet" },
    { code: "KU", name: "Parêzgeh" },
  ],
};

/** Resolve enrichment for a division (mock translations by name). */
export function generateDivision(shortName: string, name: string): DivisionDraft {
  const key = name.trim().toLowerCase();
  const translations = TRANSLATIONS[key] ?? [
    { code: "AR", name },
    { code: "TR", name },
    { code: "KU", name },
  ];
  return { shortName, name, translations };
}

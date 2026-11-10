import "server-only";
import { businessTypeSchema, type BusinessType } from "./schema";

/**
 * Single place business types are read. Server-only.
 *
 * ⚠️ MOCKED — the screen is built from its XD frames ahead of the backend.
 * The rows are the ones the design shows. Saving in the panel changes only
 * the screen (until a reload); nothing is sent anywhere.
 *
 * When the backend publishes the route, the swap keeps the schema.parse
 * boundary exactly (the project's data goes through `backendFetch`, which
 * prefixes `/v1/projects/{selected}`):
 *   const data = await backendFetch.get<unknown>("/business-types");
 *   return businessTypeSchema.array().parse(data);
 * and the panel's save becomes a Server Action in `actions.ts`.
 */
const all = { all_countries: true, countries: [] };

const MOCK: unknown[] = [
  { id: "own", kind: "individual", short_name: "OWN", name: { en: "Owner", ar: "مالك" }, ...all },
  { id: "p", kind: "individual", short_name: "P", name: { en: "Partner", ar: "شريك" }, ...all },
  { id: "s", kind: "individual", short_name: "S", name: { en: "Staff", ar: "موظف" }, ...all },
  { id: "k", kind: "individual", short_name: "K", name: { en: "Contract", ar: "متعاقد" }, ...all },
  { id: "bkr", kind: "individual", short_name: "BKR", name: { en: "Broker", ar: "وسيط" }, ...all },
  { id: "ag", kind: "individual", short_name: "AG", name: { en: "Agent", ar: "وكيل" }, ...all },
  { id: "fl", kind: "individual", short_name: "FL", name: { en: "Freelancer", ar: "عامل حر" }, ...all },
  { id: "o", kind: "corporate", short_name: "O", name: { en: "Office", ar: "مكتب" }, ...all },
  { id: "c", kind: "corporate", short_name: "C", name: { en: "Center", ar: "مركز" }, ...all },
  { id: "b", kind: "corporate", short_name: "B", name: { en: "Branch", ar: "فرع" }, ...all },
  { id: "pt", kind: "corporate", short_name: "P", name: { en: "Point", ar: "نقطة" }, ...all },
  { id: "bp", kind: "work", short_name: "BP", name: { en: "Business Partner", ar: "شريك أعمال" }, ...all },
  { id: "bo", kind: "work", short_name: "BO", name: { en: "Business Owners", ar: "أصحاب الأعمال" }, ...all },
  { id: "cd", kind: "work", short_name: "CD", name: { en: "Business Distributor", ar: "موزع أعمال" }, ...all },
];

export async function listBusinessTypes(): Promise<BusinessType[]> {
  return businessTypeSchema.array().parse(MOCK);
}

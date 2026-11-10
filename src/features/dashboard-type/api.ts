import "server-only";
import { dashboardTypeSchema, type DashboardType } from "./schema";

/**
 * Single place dashboard types are read. Server-only.
 *
 * ⚠️ MOCKED — the screen is built from its XD frame ahead of the backend. The
 * rows are the ones the design shows; saving in the panel changes only the
 * screen (until a reload) and nothing is sent.
 *
 * When the backend publishes the route, the swap keeps the parse boundary
 * (project data goes through `backendFetch`, which prefixes `/v1/projects/{selected}`):
 *   const data = await backendFetch.get<unknown>("/dashboard-types");
 *   return dashboardTypeSchema.array().parse(data);
 * and the panel's save becomes a Server Action in `actions.ts`.
 */
const all = { all_countries: true, countries: [], language: "en" };

const MOCK: unknown[] = [
  { id: "m", short_name: "M", name: { en: "Management", ar: "الإدارة" }, logo: "dashboard-type/management", ...all },
  { id: "p", short_name: "P", name: { en: "Partner", ar: "الشريك" }, logo: "dashboard-type/partner", ...all },
  { id: "b", short_name: "B", name: { en: "Business", ar: "الأعمال" }, logo: "dashboard-type/business", ...all },
];

export async function listDashboardTypes(): Promise<DashboardType[]> {
  return dashboardTypeSchema.array().parse(MOCK);
}

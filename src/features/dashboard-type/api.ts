import "server-only";
import { dashboardTypeSchema, type DashboardType } from "./schema";

/**
 * Single place dashboard types are read. Server-only.
 *
 * There is ONE type, and it is fixed: business units always sign in to the
 * Management console (`dashboard: "MANAGEMENT"`, info-tab answers §3), and no
 * other type is planned (decided 2026-11-21). So this is not a mock awaiting a
 * route: the page shows Management, read only, and nothing is ever saved.
 */
const MANAGEMENT: unknown = {
  id: "MANAGEMENT",
  short_name: "M",
  name: { en: "Management", ar: "الإدارة", tr: "Yönetim" },
  logo: "dashboard-type/management",
  all_countries: true,
  countries: [],
  language: "en",
};

export async function listDashboardTypes(): Promise<DashboardType[]> {
  return [dashboardTypeSchema.parse(MANAGEMENT)];
}

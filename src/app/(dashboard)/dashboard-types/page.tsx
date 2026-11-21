import { redirect } from "next/navigation";
import { listDashboardTypes } from "@/features/dashboard-type/api";
import { DashboardTypeList } from "@/features/dashboard-type/components/DashboardTypeList";
import { getSelectedSystem } from "@/lib/api/backend";

/**
 * System Dashboards Type — the one dashboard type business units use,
 * Management, read only (`features/dashboard-type/api.ts`). Renders inside the
 * (dashboard) shell; the layout provides the <main> scroll region and the
 * requireSession() gate. Nothing selected → back to the systems list.
 */
export default async function DashboardTypesPage() {
  if (!(await getSelectedSystem())) redirect("/systems");
  return <DashboardTypeList items={await listDashboardTypes()} />;
}

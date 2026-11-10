import { redirect } from "next/navigation";
import { listRoleCountries } from "@/features/role/api";
import { loadDashboard, loadStructure } from "@/features/work-structure/api";
import { WorkStructureScreen } from "@/features/work-structure/components/WorkStructureScreen";
import { getSelectedSystem } from "@/lib/api/backend";

/**
 * Business Work Structure — the selected project's businesses and their
 * management dashboards. Renders inside the (dashboard) shell; the layout
 * provides the <main> scroll region and the requireSession() gate, so this
 * page stays thin. Nothing selected → back to the systems list.
 *
 * The structure is mocked until the backend has it (`features/work-structure/api.ts`).
 * The flags are the project's real countries, and the page still opens
 * without them.
 */
export default async function WorkStructurePage() {
  if (!(await getSelectedSystem())) redirect("/systems");
  const [tree, dashboard, countries] = await Promise.all([
    loadStructure(),
    loadDashboard(),
    listRoleCountries().catch(() => []),
  ]);
  return (
    <WorkStructureScreen
      tree={tree}
      dashboard={dashboard}
      countries={countries.flatMap((c) => (c.code ? [c.code] : []))}
    />
  );
}

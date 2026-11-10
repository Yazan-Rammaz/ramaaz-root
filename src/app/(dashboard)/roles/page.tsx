import { redirect } from "next/navigation";
import { grantable, listPermissionCatalog, listRoleCountries, listRoles } from "@/features/role/api";
import { RoleList } from "@/features/role/components/RoleList";
import { listNameLanguages } from "@/features/language/api";
import { getSelectedSystem } from "@/lib/api/backend";

/**
 * System RBAC — the selected project's roles (editable) and its permission
 * catalog (read-only), as two tabs. Renders inside the (dashboard) shell; the
 * layout provides the <main> scroll region and the requireSession() gate, so
 * this page stays thin. Nothing selected → back to the systems list.
 */
export default async function RolesPage() {
  if (!(await getSelectedSystem())) redirect("/systems");
  const [roles, catalog, countries, languages] = await Promise.all([
    listRoles(),
    listPermissionCatalog(),
    listRoleCountries(),
    listNameLanguages(),
  ]);
  return (
    <RoleList
      roles={roles}
      catalog={catalog}
      permissions={grantable(catalog)}
      countries={countries}
      languages={languages}
    />
  );
}

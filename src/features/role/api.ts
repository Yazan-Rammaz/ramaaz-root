import "server-only";
import { z } from "zod";
import { backendFetch } from "@/lib/api/backend";
import { readAllPages } from "@/lib/api/operations";
import {
  permissionSchema,
  roleSchema,
  unitSchema,
  type Permission,
  type Role,
  type RoleCountry,
} from "./schema";

/**
 * Single place role data is read. Server-only.
 *
 * The roles screen reads three things for the selected project
 * (`backend docs/roles/from-backend/2026-11-05-task-roles-screen.md`):
 *
 *   GET …/roles         the roles, already in rank order
 *   GET …/permissions   the project's catalog, for the ⚙ tab
 *   GET …/units         its countries, for the availability flags — matched
 *                       by id to RDB's `country.list` for each one's ISO code
 *
 * The flags themselves are our bundled set by code: RDB's `flagImageUrl` is a
 * remote image the CSP does not load (the same as the Regions screen).
 */

const list = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

export async function listRoles(): Promise<Role[]> {
  return list(roleSchema).parse(await backendFetch.get<unknown>("/roles")).data;
}

/**
 * The project's whole catalog, as it publishes it — the Permissions tab shows
 * it read-only (the console cannot add or change a permission).
 */
export async function listPermissionCatalog(): Promise<Permission[]> {
  return list(permissionSchema).parse(await backendFetch.get<unknown>("/permissions")).data;
}

/**
 * What a role may hold: everything except `root_only` keys (Root alone holds
 * those; they can never be in a role) and `RETIRED` ones (they grant nothing).
 */
export function grantable(catalog: Permission[]): Permission[] {
  return catalog.filter((p) => !p.root_only && p.status !== "RETIRED");
}

const countryCodeSchema = z.object({ id: z.string(), code: z.string() }).loose();

/**
 * The project's countries, top units of its tree. A `CLOSED` one stays (RDB
 * can reopen it): it is shown marked, and may stay selected. Without RDB's
 * country list the row still works — names instead of flags.
 */
export async function listRoleCountries(): Promise<RoleCountry[]> {
  const [units, codes] = await Promise.all([
    backendFetch.get<unknown>("/units"),
    readAllPages("country.list", { query: { includeDeleted: "true" } })
      .then((rows) => z.array(countryCodeSchema).parse(rows))
      .catch(() => []),
  ]);
  const codeById = new Map(codes.map((c) => [c.id, c.code]));
  return list(unitSchema)
    .parse(units)
    .data.filter((u) => u.kind === "country" && u.status !== "RETIRED")
    .map((u) => ({ id: u.id, name: u.name, code: codeById.get(u.id), closed: u.status === "CLOSED" }));
}

import { z } from "zod";

/*
 * A project's roles — the System RBAC screen
 * (`backend docs/roles/from-backend/2026-11-05-task-roles-screen.md`).
 *
 * The root backend's own routes under `/v1/projects/{id}/roles` (snake_case),
 * not a project operation. Only what the screen reads is required; the rest
 * is left to `.loose()` so a field the backend adds never fails the page.
 */

/** A name keyed by language code — `{ en, ar }` today, one more key per language later. */
export const roleNameSchema = z.record(z.string(), z.string());
export type RoleName = z.infer<typeof roleNameSchema>;

/** A permission as a role holds it; `RETIRED` keys grant nothing and are never sent back. */
const heldPermissionSchema = z.object({ key: z.string(), status: z.string() });

/** A country the role is limited to (a unit of the project). */
const roleCountrySchema = z
  .object({ id: z.string(), name: roleNameSchema.optional(), status: z.string().optional() })
  .loose();

export const roleSchema = z
  .object({
    id: z.string(),
    short_name: z.string(),
    name: roleNameSchema,
    /** 1 is the most senior. Only the order matters — there may be gaps. */
    rank: z.number(),
    permissions: z.array(heldPermissionSchema),
    all_countries: z.boolean(),
    countries: z.array(roleCountrySchema),
    /** How many people hold it: a change reaches all of them, and a held role can't be deleted. */
    holders: z.number().int().nonnegative().default(0),
  })
  .loose();
export type Role = z.infer<typeof roleSchema>;

/** One permission the project publishes (`GET …/permissions`). */
export const permissionSchema = z
  .object({
    key: z.string(),
    label: roleNameSchema.optional(),
    sensitive: z.boolean().optional(),
    root_only: z.boolean().optional(),
    grantable_at: z.array(z.string()).optional(),
    status: z.string(),
  })
  .loose();
export type Permission = z.infer<typeof permissionSchema>;

/**
 * The badge for a permission in the list: the catalog has no short name, so
 * it is the initials of its key — the resource, then the action
 * (`regions:write` → `RW`, `employees:pay_read` → `EP`).
 */
export function permissionChip(key: string): string {
  const [resource = "", action = ""] = key.split(":");
  return (resource.charAt(0) + action.charAt(0)).toUpperCase() || key.slice(0, 2).toUpperCase();
}

/** A unit of the project's tree (`GET …/units`); the screen keeps the countries. */
export const unitSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: roleNameSchema,
    status: z.string(),
  })
  .loose();

/** A country in the availability row: RDB's id, its name, and its ISO code for the flag. */
export type RoleCountry = {
  id: string;
  name: RoleName;
  /** For our bundled flag; unknown when RDB's country list could not be read. */
  code?: string;
  closed: boolean;
};

/* ───────────────────────── What the panel sends ───────────────────────── */

/** 1–4 letters or digits; unique in the project, case-insensitively (checked by the backend). */
export const SHORT_NAME = /^[A-Za-z0-9]{1,4}$/;

/**
 * A role's complete definition — Add and Edit send the same body. Blank names
 * are dropped; at least one must remain. Countries only with `all_countries`
 * false (sending both is refused).
 */
export const roleInputSchema = z
  .object({
    short_name: z.string().trim().regex(SHORT_NAME),
    name: roleNameSchema
      .transform((n) =>
        Object.fromEntries(
          Object.entries(n)
            .map(([k, v]) => [k, v.trim()] as const)
            .filter(([, v]) => v !== ""),
        ),
      )
      .refine((n) => Object.keys(n).length > 0)
      .refine((n) => Object.values(n).every((v) => v.length <= 80)),
    permissions: z.array(z.string().min(1)),
    all_countries: z.boolean(),
    countries: z.array(z.string().min(1)),
  })
  .refine((r) => !r.all_countries || r.countries.length === 0);
export type RoleInput = z.input<typeof roleInputSchema>;

/** The whole new order, most senior first — every role id once. */
export const roleOrderSchema = z.array(z.string().min(1)).min(1);

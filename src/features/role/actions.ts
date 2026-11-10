"use server";

import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { backendFetch } from "@/lib/api/backend";
import { ApiError, SessionLockedError } from "@/lib/api/server";
import { apiErrorSchema } from "@/lib/auth/endpoints";
import { correlationId, errorCode, retryAfterSeconds } from "@/lib/auth/errors";
import { roleInputSchema, roleOrderSchema, roleSchema, type Role, type RoleInput } from "./schema";

/*
 * The roles screen's writes — the root backend's routes under
 * `/v1/projects/{id}/roles` (task 2026-11-05 §2–§5). Every one answers a
 * `RoleResult`; the panel places it:
 *
 *   role / roles / deleted   what the backend now has — the list takes it.
 *   fields                   `422 VALIDATION_FAILED`, one message per input,
 *                            keyed as the request (`short_name`, `name.en`,
 *                            `countries[0]`, …), shown under that input.
 *   reload                   the list moved underneath (`404` on a role
 *                            another Root deleted, `422` on an order that no
 *                            longer covers every role) — read it again.
 *   locked                   the session wants the PIN; nothing was sent.
 *   error                    one line for the whole action.
 */
export type RoleResult = {
  role?: Role;
  roles?: Role[];
  deleted?: true;
  fields?: Record<string, string>;
  reload?: true;
  locked?: true;
  error?: string;
};

async function failure(error: unknown, { reloadOn422 = false } = {}): Promise<RoleResult> {
  if (error instanceof SessionLockedError) return { locked: true };
  const t = await getTranslations("rbac.errors");
  const code = errorCode(error);
  const status = error instanceof ApiError ? error.status : 0;
  const body = apiErrorSchema.safeParse(error instanceof ApiError ? error.body : undefined);
  const detail = body.success ? body.data.error : undefined;

  if (code === "RATE_LIMITED") return { error: t("rateLimited", { seconds: retryAfterSeconds(error) ?? 60 }) };
  if (status === 403) return { error: t("forbidden") };
  if (status === 404) return { error: t("gone"), reload: true };
  if (status === 422 && detail?.fields && Object.keys(detail.fields).length) {
    // A sort that no longer covers every role: someone added or deleted one.
    if (reloadOn422) return { error: t("orderChanged"), reload: true };
    return { fields: detail.fields, error: detail.message };
  }
  // 409 on delete (somebody holds it) and every other refusal: the backend's words.
  if (detail?.message) return { error: detail.message };
  return { error: t("generic", { ref: correlationId(error) ?? "—" }) };
}

async function invalid(): Promise<RoleResult> {
  return { error: (await getTranslations("rbac.errors"))("invalid") };
}

const one = z.object({ data: roleSchema }).or(roleSchema);
const parseRole = (raw: unknown): Role => {
  const r = one.parse(raw);
  return "data" in r ? (r.data as Role) : (r as Role);
};

/** Add a role. It arrives last — the most junior. */
export async function createRoleAction(input: RoleInput): Promise<RoleResult> {
  const parsed = roleInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  try {
    return { role: parseRole(await backendFetch.post<unknown>("/roles", parsed.data)) };
  } catch (error) {
    return failure(error);
  }
}

/** Edit a role: its COMPLETE definition, never just the changed field. */
export async function updateRoleAction(id: string, input: RoleInput): Promise<RoleResult> {
  const parsed = roleInputSchema.safeParse(input);
  if (!parsed.success || !id) return invalid();
  try {
    return {
      role: parseRole(await backendFetch.put<unknown>(`/roles/${encodeURIComponent(id)}`, parsed.data)),
    };
  } catch (error) {
    return failure(error);
  }
}

/** Save the whole order at once — every role id, most senior first. Answers every role with its new rank. */
export async function reorderRolesAction(ids: string[]): Promise<RoleResult> {
  const parsed = roleOrderSchema.safeParse(ids);
  if (!parsed.success) return invalid();
  try {
    const raw = await backendFetch.put<unknown>("/roles/order", { roles: parsed.data });
    return { roles: z.object({ data: z.array(roleSchema) }).parse(raw).data };
  } catch (error) {
    return failure(error, { reloadOn422: true });
  }
}

/** Delete a role nobody holds (`409` when somebody does). Cannot be undone. */
export async function deleteRoleAction(id: string): Promise<RoleResult> {
  if (!id) return invalid();
  try {
    await backendFetch.delete<unknown>(`/roles/${encodeURIComponent(id)}`);
    return { deleted: true };
  } catch (error) {
    return failure(error);
  }
}

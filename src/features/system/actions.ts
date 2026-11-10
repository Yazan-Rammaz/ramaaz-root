"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { setSelectedSystemCookie } from "@/lib/api/backend";
import { ApiError, SessionLockedError } from "@/lib/api/server";
import { apiErrorSchema } from "@/lib/auth/endpoints";
import { correlationId, errorCode, retryAfterSeconds } from "@/lib/auth/errors";
import { connectProject, createProject, getSystem } from "./api";
import {
  connectProjectSchema,
  createProjectSchema,
  type System,
} from "./schema";

/**
 * Select the system (company project) the dashboard works on. Every
 * project-data page (regions, currencies, languages, …) reads and mutates
 * through the selected system via `backendFetch`.
 */
export async function selectSystem(id: string): Promise<void> {
  // Resolve against the registry first — an unknown id (stale UI, tampering)
  // must not land in the cookie.
  //
  // `getSystem` answers null rather than throwing: the registry is a list on
  // the session response, not a route that can 404, so "not in it" is an
  // ordinary answer. Refuse silently — the id came from our own list, so a miss
  // means that list moved, and re-rendering shows the current one.
  //
  // Only a project the backend calls `selectable` (ACTIVE + CONNECTED) can be
  // picked: every data call to any other one is refused
  // (`409 PROJECT_NOT_AVAILABLE`), so its pages would hold nothing but errors.
  const system = await getSystem(id);
  if (!system?.selectable) return;

  await setSelectedSystemCookie(system.id);
  // The data source of every project page just changed.
  revalidatePath("/", "layout");
}

/* ───────────────────── Adding a project (console-api.md §5) ───────────────────── */

type Field = "code" | "name" | "name_ar" | "description" | "base_url";

/**
 * What the add drawer renders after each step. `project` is the project as the
 * backend now has it; `error` is one line for the whole form, `fields` one per
 * input. Everything is already translated: the drawer only places it.
 */
export type ProjectFormState = {
  project?: System;
  error?: string;
  fields?: Partial<Record<Field, string>>;
  /**
   * The session needs the PIN (SessionLockedError): nothing was sent. The
   * drawer raises the lock overlay; after unlocking, the same button works,
   * with everything typed still there.
   */
  locked?: boolean;
};

/** A backend refusal → what the form says. The backend's own wording for fields. */
async function failure(error: unknown): Promise<ProjectFormState> {
  if (error instanceof SessionLockedError) return { locked: true };

  const t = await getTranslations("system.errors");
  const code = errorCode(error);
  const body = apiErrorSchema.safeParse(error instanceof ApiError ? error.body : undefined);
  const detail = body.success ? body.data.error : undefined;

  switch (code) {
    case "PROJECT_CODE_TAKEN":
      return { fields: { code: t("codeTaken") } };
    case "VALIDATION_FAILED":
    case "BASE_URL_NOT_ALLOWED": {
      const fields = { ...detail?.fields, ...detail?.details?.fields };
      return Object.keys(fields).length
        ? { fields: fields as ProjectFormState["fields"] }
        : { error: detail?.message ?? t("generic", { ref: "—" }) };
    }
    case "PROJECT_SUSPENDED":
      return { error: t("suspended") };
    case "FORBIDDEN":
      return { error: t("forbidden") };
    case "RATE_LIMITED":
      return { error: t("rateLimited", { seconds: retryAfterSeconds(error) ?? 60 }) };
    default:
      // Unknown → say so, with the id support needs to find the request.
      return { error: t("generic", { ref: correlationId(error) ?? "—" }) };
  }
}

/** Zod's verdict → one translated line per field it refused. */
async function invalid(
  issues: { path: PropertyKey[] }[],
): Promise<ProjectFormState> {
  const t = await getTranslations("system.form.invalid");
  const fields: ProjectFormState["fields"] = {};
  for (const issue of issues) {
    const field = issue.path[0] as Field;
    fields[field] ??= t(field);
  }
  return { fields };
}

/** Step 1 — create. The project is DRAFT until it connects. */
export async function createProjectAction(
  _prev: ProjectFormState,
  form: FormData,
): Promise<ProjectFormState> {
  const parsed = createProjectSchema.safeParse({
    code: form.get("code") ?? "",
    name: form.get("name") ?? "",
    name_ar: form.get("name_ar") ?? "",
    description: form.get("description") ?? "",
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  try {
    const project = await createProject(parsed.data);
    revalidatePath("/systems");
    return { project };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Step 2 — save the base URL and run the handshake. A handshake that FAILS is
 * still a success here: the reason rides on `project.connectionError`.
 */
export async function connectProjectAction(
  id: string,
  _prev: ProjectFormState,
  form: FormData,
): Promise<ProjectFormState> {
  const parsed = connectProjectSchema.safeParse({ base_url: form.get("base_url") ?? "" });
  if (!parsed.success) return invalid(parsed.error.issues);

  try {
    const project = await connectProject(id, parsed.data.base_url);
    revalidatePath("/", "layout");
    return { project };
  } catch (error) {
    return failure(error);
  }
}

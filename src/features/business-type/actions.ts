"use server";

import { getTranslations } from "next-intl/server";
import { commandOrRetry, oneParam } from "@/lib/api/operations";
import { ApiError, SessionLockedError } from "@/lib/api/server";
import { apiErrorSchema } from "@/lib/auth/endpoints";
import { correlationId, errorCode, retryAfterSeconds } from "@/lib/auth/errors";
import { toBusinessType } from "./api";
import { businessTypeInputSchema, rdbCatalogItemSchema, type BusinessType, type BusinessTypeInput } from "./schema";

/*
 * The business-type screen's writes — RDB commands through the console:
 * `business_type.create` / `.update` (Individual, Corporate) and
 * `work_type.create` / `.update` (Business Work Type).
 *
 * Bodies as RDB wrote them (open-questions answers §2): create takes `key`,
 * `shortName`, `name`, `countries` and, for a business type, `group`; update
 * takes the changed fields with `expectedUpdatedAt`, never `key` or `group`.
 * A taken key or short name (`409 CATALOG_KEY_TAKEN` / `_SHORT_NAME_TAKEN`) and
 * a stale edit (`409 STALE_UPDATE`) come back in RDB's own words.
 *
 *   type       what RDB now has — the list takes it.
 *   fields     `422`, one message per field.
 *   commandId  it came back UNKNOWN: the next press retries that command.
 *   locked     the session wants the PIN; nothing was sent.
 *   error      one line for the whole action.
 */
export type BusinessTypeResult = {
  type?: BusinessType;
  fields?: Record<string, string>;
  commandId?: string;
  locked?: true;
  error?: string;
};

/**
 * "Business Owners" → "business_owners": a new item's key, from its English name
 * (open-questions answers §2). RDB fixes it for ever: lowercase letters, digits
 * and `_`, at most 40. A rename later never changes it. Empty when the name has
 * nothing usable left — then the save is refused here, not guessed.
 */
function keyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}

async function failure(error: unknown): Promise<BusinessTypeResult> {
  if (error instanceof SessionLockedError) return { locked: true };
  const t = await getTranslations("businessType.errors");
  const status = error instanceof ApiError ? error.status : 0;
  const body = apiErrorSchema.safeParse(error instanceof ApiError ? error.body : undefined);
  const detail = body.success ? body.data.error : undefined;
  console.warn(
    `[business-type] write refused: status=${status || "-"} code=${errorCode(error) ?? "-"} correlation_id=${correlationId(error) ?? "-"}`,
  );
  if (errorCode(error) === "RATE_LIMITED") return { error: t("rateLimited", { seconds: retryAfterSeconds(error) ?? 60 }) };
  if (status === 403) return { error: t("forbidden") };
  if (status === 422 && detail?.fields && Object.keys(detail.fields).length) return { fields: detail.fields, error: detail.message };
  // Every other refusal (a key taken, a stale edit): RDB's own words.
  if (detail?.message) return { error: detail.message };
  return { error: t("generic", { ref: correlationId(error) ?? "—" }) };
}

/** Add (no `key`) or change one business type, saved to RDB. */
export async function saveBusinessTypeAction(input: BusinessTypeInput, pendingCommandId?: string): Promise<BusinessTypeResult> {
  const parsed = businessTypeInputSchema.safeParse(input);
  if (!parsed.success) return { error: (await getTranslations("businessType.errors"))("invalid") };
  const v = parsed.data;
  const catalog = v.kind === "work" ? "work_type" : "business_type";
  const fields = {
    shortName: v.short_name.toUpperCase(),
    name: v.name,
    countries: v.all_countries ? "all" : v.countries,
  };
  const key = v.key ? undefined : keyOf(v.name.en ?? "");
  if (key === "") return { error: (await getTranslations("businessType.errors"))("noKey") };
  try {
    const outcome = v.key
      ? await commandOrRetry(
          `${catalog}.update`,
          {
            params: await oneParam(`${catalog}.update`, v.key, "key"),
            body: { ...fields, ...(v.updatedAt ? { expectedUpdatedAt: v.updatedAt } : {}) },
          },
          pendingCommandId,
        )
      : await commandOrRetry(
          `${catalog}.create`,
          {
            body: {
              key,
              ...fields,
              ...(v.kind === "work" ? {} : { group: v.kind }),
            },
          },
          pendingCommandId,
        );
    if (outcome.status === "UNKNOWN") {
      return { error: (await getTranslations("businessType.errors"))("notConfirmed"), commandId: outcome.commandId };
    }
    const saved = rdbCatalogItemSchema.safeParse(outcome.data);
    return {
      type: saved.success
        ? toBusinessType(saved.data, v.kind)
        : {
            id: v.key ?? key ?? "",
            kind: v.kind,
            short_name: fields.shortName,
            name: v.name,
            all_countries: v.all_countries,
            countries: v.all_countries ? [] : v.countries,
          },
    };
  } catch (error) {
    return failure(error);
  }
}

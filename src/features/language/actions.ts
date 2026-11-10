"use server";

import { getTranslations } from "next-intl/server";
import { oneParam, readOperation } from "@/lib/api/operations";
import { errorCode } from "@/lib/auth/errors";
import { failure, field, invalid, step, stopped, type Resume, type WriteResult } from "@/features/region/write";
import {
  createLanguageSchema,
  languageSchema,
  languageStatusSchema,
  updateLanguageSchema,
  type CreateLanguageInput,
  type LanguageStatusInput,
  type UpdateLanguageInput,
} from "./schema";

/*
 * The Languages screen's writes — RDB commands through the console
 * (`backend docs/project-data/from-backend/2026-11-08-languages-screen-and-names.md` §3).
 * All three need `languages:write`, granted at the project only. Each answers
 * a `WriteResult` (`features/region/write.ts`).
 *
 * The notes give each operation's body but not its path, so the language's
 * placeholder is read from RDB's own operation list (`oneParam`).
 */

/**
 * Add a language (`language.create`). It always starts as `DRAFT`, so adding
 * one shows customers nothing. A code already in the list — `en`, `ar` or one
 * set `INACTIVE` included; languages are never deleted — is
 * `409 LANGUAGE_EXISTS`.
 */
export async function createLanguageAction(input: CreateLanguageInput, resume?: Resume): Promise<WriteResult> {
  const parsed = createLanguageSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { code, nameEn, nameAr, nativeName, direction, fallback, sortOrder } = parsed.data;

  try {
    const created = await step(
      "language.create",
      {
        body: {
          code,
          name: { en: nameEn, ar: nameAr },
          nativeName,
          direction,
          ...(fallback ? { fallback } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
        },
      },
      "create",
      resume,
      {},
    );
    if (stopped(created)) return created;
    return { ok: { id: code, updatedAt: field(created.data, "updatedAt") } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Edit a language (`language.update`): only the fields that changed, and the
 * `updatedAt` it was read with. On `en` and `ar` only the names may change
 * (`409 LANGUAGE_REQUIRED` otherwise). `409 STALE_UPDATE`: somebody saved
 * first and nothing was saved — the answer carries the language as it is now
 * (`fresh`) and the next save is a new press, so a new key.
 */
export async function updateLanguageAction(input: UpdateLanguageInput, resume?: Resume): Promise<WriteResult> {
  const parsed = updateLanguageSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { code, nameEn, nameAr, nativeName, direction, fallback, sortOrder, expectedUpdatedAt } = parsed.data;
  const name = { ...(nameEn ? { en: nameEn } : {}), ...(nameAr ? { ar: nameAr } : {}) };

  try {
    const updated = await step(
      "language.update",
      {
        params: await oneParam("language.update", code, "code"),
        body: {
          ...(Object.keys(name).length ? { name } : {}),
          ...(nativeName !== undefined ? { nativeName } : {}),
          ...(direction !== undefined ? { direction } : {}),
          ...(fallback !== undefined ? { fallback } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        },
      },
      "update",
      resume,
      {},
    );
    if (stopped(updated)) return updated;
    return { ok: { id: code, updatedAt: field(updated.data, "updatedAt") } };
  } catch (error) {
    const result = await failure(error);
    if (errorCode(error) !== "STALE_UPDATE") return result;
    try {
      const [list, t] = await Promise.all([readOperation("language.list"), getTranslations("region.errors")]);
      const fresh = languageSchema.array().parse(list).find((l) => l.code === code);
      return fresh ? { ...result, error: t("staleReloaded"), fresh } : result;
    } catch {
      return result;
    }
  }
}

/**
 * Change a language's status (`language.status.update`), with a reason kept
 * in the console's journal — never in the body. Any status can move to any
 * other; `en` and `ar` always stay `ACTIVE` (`409 LANGUAGE_REQUIRED`).
 * Customers see the change within a minute.
 */
export async function setLanguageStatusAction(input: LanguageStatusInput, resume?: Resume): Promise<WriteResult> {
  const parsed = languageStatusSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { code, status, reason } = parsed.data;

  try {
    const changed = await step(
      "language.status.update",
      { params: await oneParam("language.status.update", code, "code"), body: { status }, reason },
      "status",
      resume,
      {},
    );
    if (stopped(changed)) return changed;
    return { ok: { id: code, updatedAt: field(changed.data, "updatedAt") } };
  } catch (error) {
    return failure(error);
  }
}

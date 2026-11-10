"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { readOperation } from "@/lib/api/operations";
import { errorCode } from "@/lib/auth/errors";
import { failure, field, invalid, step, stopped, type Resume, type WriteResult } from "@/features/region/write";
import { toCurrency } from "./api";
import { rdbCurrencySchema, updateCurrencySchema, type UpdateCurrencyInput } from "./schema";

/**
 * Edit a currency: `currency.update` with only what changed — its ISO code
 * (`symbol`), its name in the languages that changed (`null` removes one),
 * whether it is active — and the `updatedAt` it was read with
 * (`2026-11-08-stale-update-branch-currency-employee-pay.md`).
 *
 * `409 STALE_UPDATE`: somebody else saved first and nothing was saved. The
 * answer carries the currency as it is now (`fresh`), so the form shows the
 * new values; saving again is a new press, so a new `Idempotency-Key` — never
 * the console's retry, which would resend the old one.
 */
export async function updateCurrencyAction(input: UpdateCurrencyInput, resume?: Resume): Promise<WriteResult> {
  const parsed = updateCurrencySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { id, symbol, name, isActive, expectedUpdatedAt } = parsed.data;

  try {
    const updated = await step(
      "currency.update",
      {
        params: { id },
        body: {
          ...(symbol !== undefined ? { symbol } : {}),
          ...(name ? { name } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        },
      },
      "update",
      resume,
      {},
    );
    if (stopped(updated)) return updated;
    return { ok: { id, updatedAt: field(updated.data, "updatedAt") } };
  } catch (error) {
    const result = await failure(error);
    if (errorCode(error) !== "STALE_UPDATE") return result;
    try {
      const [now, locale, t] = await Promise.all([
        readOperation("currency.get", { params: { id } }),
        getLocale(),
        getTranslations("region.errors"),
      ]);
      return { ...result, error: t("staleReloaded"), fresh: toCurrency(rdbCurrencySchema.parse(now), locale) };
    } catch {
      return result;
    }
  }
}

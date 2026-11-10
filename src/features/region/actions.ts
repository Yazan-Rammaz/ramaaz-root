"use server";

import { getTranslations } from "next-intl/server";
import { readOperation } from "@/lib/api/operations";
import { errorCode } from "@/lib/auth/errors";
import {
  closeUnitSchema,
  createCountrySchema,
  createCurrencySchema,
  createDivisionSchema,
  createRegionSchema,
  flagFileSchema,
  updateCountrySchema,
  updateRegionSchema,
  type CloseUnitInput,
  type CreateCountryInput,
  type CreateCurrencyInput,
  type CreateDivisionInput,
  type CreateRegionInput,
  type FlagFile,
  type UpdateCountryInput,
  type UpdateRegionInput,
} from "./schema";
import { toAlpha2 } from "./mock-geo";
import { failure, field, invalid, step, stopped, type Resume, type WriteResult } from "./write";

/*
 * The geography writes — RDB commands through the console
 * (`backend docs/project-data/from-backend/2026-10-30-rdb-screens.md` §2.2, §4.2–§4.5).
 * Called imperatively by the drawers (they are wizards, not forms); every one
 * answers a `WriteResult` (`./write.ts` says what each part means).
 *
 * Names go out as RDB keeps them, an open map over the project's languages
 * (`2026-11-08-languages-screen-and-names.md` §2): a create sends every filled
 * language, an edit only those that changed (`null` removes one).
 */

/**
 * Make `currencyId` the country's default (answers 2026-11-05 §1): assign it,
 * or — already linked (`409 CURRENCY_ALREADY_ASSIGNED`) — update the link.
 * Setting a new default clears the old one by itself; the old link stays, so
 * its customers can still deposit and withdraw in it.
 */
async function setDefaultCurrency(
  countryId: string,
  currencyId: string,
  resume: Resume | undefined,
  keep: Omit<Resume, "commandId" | "step">,
): Promise<{ data: unknown } | WriteResult> {
  console.info(`[rdb] country.currency.assign ${currencyId} → country ${countryId}`);
  try {
    return await step(
      "country.currency.assign",
      { params: { id: countryId }, body: { currencyId, isDefault: true } },
      "currency",
      resume,
      keep,
    );
  } catch (error) {
    if (errorCode(error) !== "CURRENCY_ALREADY_ASSIGNED") throw error;
    return step(
      "country.currency.update",
      { params: { id: countryId, currencyId }, body: { isDefault: true } },
      "currency",
      undefined,
      keep,
    );
  }
}

/**
 * A refused country edit. `404 COUNTRY_NOT_FOUND` most likely means somebody
 * closed it while the form was open (2026-11-08 closed-country note): RDB's
 * message is shown, and when `country.get` confirms it is closed the screen
 * shows it closed — read-only, with Reopen.
 */
async function countryFailure(countryId: string, error: unknown, carry?: Resume): Promise<WriteResult> {
  const result = await failure(error, carry);
  if (errorCode(error) !== "COUNTRY_NOT_FOUND") return result;
  try {
    const country = await readOperation("country.get", { params: { id: countryId } });
    if (field(country, "deletedAt")) return { ...result, closed: true };
  } catch {
    // Gone altogether, or unreadable: RDB's message stands on its own.
  }
  return result;
}

/** The country's `updatedAt` now — what its next edit must send back. Unknown on a failed read. */
async function currentUpdatedAt(countryId: string): Promise<string | undefined> {
  try {
    return field(await readOperation("country.get", { params: { id: countryId } }), "updatedAt");
  } catch {
    return undefined;
  }
}

/**
 * ⚠️ Only while RDB's `media.upload` is not deployed yet (answers §1): a public
 * flag by ISO code. Once it is, every flag is uploaded to RDB instead and this
 * is never sent.
 */
const flagcdnUrlFor = (code: string) => `https://flagcdn.com/${toAlpha2(code).toLowerCase()}.svg`;

/** Upload a flag to RDB; its answer's `url` is what `flagImageUrl` takes. */
async function uploadFlag(
  flag: FlagFile,
  resume: Resume | undefined,
  keep: Omit<Resume, "commandId" | "step">,
): Promise<{ url: string } | WriteResult> {
  const r = await step(
    "media.upload",
    { body: { purpose: "country_flag", contentType: flag.contentType, data: flag.data } },
    "upload",
    resume,
    keep,
  );
  if (stopped(r)) return r;
  const url = field(r.data, "url");
  return url ? { url } : { error: (await getTranslations("region.errors"))("generic", { ref: "media.upload" }) };
}

/**
 * Add a country: upload its flag (when RDB offers uploads), create it with
 * the flag's link, then set its levels — up to three commands, each its own
 * `Idempotency-Key`. A press after a failure picks up where the last one
 * stopped (`Resume`): the flag is never uploaded twice, the country never
 * created twice.
 *
 * `flag` is the file to upload; null while RDB has no `media.upload`, which
 * falls back to the flagcdn link.
 */
export async function createCountryAction(
  input: CreateCountryInput,
  flag: FlagFile | null,
  resume?: Resume,
): Promise<WriteResult> {
  const parsed = createCountrySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const file = flag ? flagFileSchema.safeParse(flag) : null;
  if (file && !file.success) return invalid(file.error.issues.map(() => ({ path: ["flag"] })));
  const { code, name, dialCode, levels, currencyId, mainLanguage } = parsed.data;

  let flagUrl = resume?.flagUrl;
  let countryId = resume?.countryId;
  let levelsDone = resume?.levelsDone ?? false;
  try {
    if (!countryId) {
      if (!flagUrl) {
        if (file?.success) {
          const uploaded = await uploadFlag(file.data, resume, {});
          if (!("url" in uploaded)) return uploaded;
          flagUrl = uploaded.url;
        } else {
          flagUrl = flagcdnUrlFor(code);
        }
      }

      const created = await step(
        "country.create",
        {
          body: {
            name,
            code,
            dialCode,
            flagImageUrl: flagUrl,
            isActive: true,
            ...(mainLanguage ? { mainLanguage } : {}),
          },
        },
        "create",
        resume,
        { flagUrl },
      );
      if (stopped(created)) return created;
      countryId = field(created.data, "id") ?? "";
    }

    if (levels.length && !levelsDone) {
      const set = await step(
        "country.levels.update",
        {
          params: { id: countryId },
          body: { levels: levels.map((regionType) => ({ regionType, optional: false })) },
        },
        "levels",
        resume,
        { countryId },
      );
      if (stopped(set)) return set;
    }
    levelsDone = true;

    if (currencyId) {
      const linked = await setDefaultCurrency(countryId, currencyId, resume, { countryId, levelsDone });
      if (stopped(linked)) return linked;
    }
    return { ok: { id: countryId } };
  } catch (error) {
    // Keep what went through: a created country (and its levels), or at least its uploaded flag.
    return failure(
      error,
      countryId ? { countryId, levelsDone } : flagUrl ? { flagUrl } : undefined,
    );
  }
}

/**
 * Give an existing country a new flag: upload it, then `country.update` with
 * only `flagImageUrl` (answers §1). Also how the countries created with a
 * flagcdn link are moved onto RDB-hosted flags once uploads exist.
 */
export async function updateCountryFlagAction(
  countryId: string,
  flag: FlagFile,
  resume?: Resume,
): Promise<WriteResult> {
  const file = flagFileSchema.safeParse(flag);
  if (!file.success || !countryId) return invalid([{ path: ["flag"] }]);

  let flagUrl = resume?.flagUrl;
  try {
    if (!flagUrl) {
      const uploaded = await uploadFlag(file.data, resume, {});
      if (!("url" in uploaded)) return uploaded;
      flagUrl = uploaded.url;
    }
    const updated = await step(
      "country.update",
      { params: { id: countryId }, body: { flagImageUrl: flagUrl } },
      "update",
      resume,
      { flagUrl },
    );
    if (stopped(updated)) return updated;
    return { ok: { id: countryId, updatedAt: field(updated.data, "updatedAt") } };
  } catch (error) {
    return countryFailure(countryId, error, flagUrl ? { flagUrl } : undefined);
  }
}

/**
 * Edit a saved country: `country.update` with its code, names, dial code and
 * the `updatedAt` it was read with (`expectedUpdatedAt`: someone else's change
 * since is `409 STALE_UPDATE`, nothing saved); then — only when they changed —
 * its level order (`country.levels.update`, refused with `409 LEVEL_IN_USE` for
 * a level its regions use) and its default currency. A press after a failure
 * sends only the steps still left. Answers the country's new `updatedAt`.
 */
export async function updateCountryAction(
  input: UpdateCountryInput,
  resume?: Resume,
): Promise<WriteResult> {
  const parsed = updateCountrySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { id, code, name, dialCode, levels, levelsChanged, currencyId, mainLanguage, expectedUpdatedAt } =
    parsed.data;

  // `countryId` in the carry means the update itself is done.
  let updatedId = resume?.countryId;
  let levelsDone = resume?.levelsDone ?? false;
  try {
    if (!updatedId) {
      const updated = await step(
        "country.update",
        {
          params: { id },
          body: {
            code,
            ...(name ? { name } : {}),
            dialCode,
            ...(mainLanguage ? { mainLanguage } : {}),
            ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
          },
        },
        "update",
        resume,
        {},
      );
      if (stopped(updated)) return updated;
      updatedId = id;
    }
    if (levelsChanged && !levelsDone) {
      const set = await step(
        "country.levels.update",
        {
          params: { id },
          body: { levels: levels.map((regionType) => ({ regionType, optional: false })) },
        },
        "levels",
        resume,
        { countryId: updatedId },
      );
      if (stopped(set)) return set;
    }
    levelsDone = true;
    if (currencyId) {
      const linked = await setDefaultCurrency(id, currencyId, resume, { countryId: updatedId, levelsDone });
      if (stopped(linked)) return linked;
    }
    // Read back, not taken from `country.update`: the levels and currency
    // steps may have moved it on since.
    return { ok: { id, updatedAt: await currentUpdatedAt(id) } };
  } catch (error) {
    return countryFailure(id, error, updatedId ? { countryId: updatedId, levelsDone } : undefined);
  }
}

/**
 * Edit a saved region: `region.update` with its names, ISO code (`null` clears
 * it), its type when it changed (allowed while nothing is below it:
 * `409 REGION_NOT_EMPTY`), and the `updatedAt` it was read with. Answers the
 * region's new `updatedAt`.
 */
export async function updateRegionAction(
  input: UpdateRegionInput,
  resume?: Resume,
): Promise<WriteResult> {
  const parsed = updateRegionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { id, name, isoCode, regionType, expectedUpdatedAt } = parsed.data;

  try {
    const updated = await step(
      "region.update",
      {
        params: { region_id: id },
        body: {
          ...(name ? { name } : {}),
          isoCode,
          ...(regionType ? { regionType } : {}),
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
    return failure(error);
  }
}

/**
 * Add a currency the system lacks, so a country can be linked to it
 * (answers 2026-11-05 §1). Only ever on the administrator's click. Answers
 * RDB's id for it; a code already taken is `409 CURRENCY_SYMBOL_EXISTS`.
 */
export async function createCurrencyAction(
  input: CreateCurrencyInput,
  resume?: Resume,
): Promise<WriteResult> {
  const parsed = createCurrencySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { symbol, name } = parsed.data;

  try {
    const created = await step(
      "currency.create",
      { body: { name, symbol, isActive: true } },
      "create",
      resume,
      {},
    );
    if (stopped(created)) return created;
    const id = field(created.data, "id") ?? "";
    // The id the country link will send (`country.currency.assign`) — logged
    // so a later `404 CURRENCY_NOT_FOUND` can be checked against it.
    console.info(`[rdb] currency.create ${symbol} → id ${id || "(none in the answer)"}`);
    return { ok: { id } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Close a country or region (answers 2026-11-05 §4) — with a reason, kept in
 * the console's journal. RDB never closes what is below: an open region or
 * branch underneath is `409 UNIT_HAS_ACTIVE_CHILDREN`, so it goes bottom up.
 * Closing twice changes nothing.
 */
export async function closeUnitAction(input: CloseUnitInput, resume?: Resume): Promise<WriteResult> {
  const parsed = closeUnitSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { kind, id, reason } = parsed.data;

  try {
    const closed = await step(
      kind === "country" ? "country.close" : "region.close",
      { params: kind === "country" ? { id } : { region_id: id }, reason },
      "close",
      resume,
      {},
    );
    if (stopped(closed)) return closed;
    return { ok: { id } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Reopen a closed country (`country.reopen`, answers 2026-11-05 §4) — with a
 * reason, like the close. Only offered while `/operations` lists it. What was
 * closed below it stays closed. Refused with `409 COUNTRY_CODE_EXISTS` when a
 * live country has taken its code since; reopening an open one changes nothing.
 * Answers its new `updatedAt`.
 */
export async function reopenCountryAction(input: CloseUnitInput, resume?: Resume): Promise<WriteResult> {
  const parsed = closeUnitSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== "country") return invalid(parsed.error?.issues ?? [{ path: ["kind"] }]);
  const { id, reason } = parsed.data;

  try {
    const reopened = await step("country.reopen", { params: { id }, reason }, "reopen", resume, {});
    if (stopped(reopened)) return reopened;
    return { ok: { id, updatedAt: field(reopened.data, "updatedAt") ?? (await currentUpdatedAt(id)) } };
  } catch (error) {
    return failure(error);
  }
}

/** Add a region under a country or another region (§4.5). */
export async function createRegionAction(
  input: CreateRegionInput,
  resume?: Resume,
): Promise<WriteResult> {
  const parsed = createRegionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { parentId, name, regionType, isoCode } = parsed.data;

  try {
    const created = await step(
      "region.create",
      {
        params: { parent_id: parentId },
        body: {
          name,
          ...(regionType ? { regionType } : {}),
          ...(isoCode ? { isoCode } : {}),
        },
      },
      "create",
      resume,
      {},
    );
    if (stopped(created)) return created;
    return { ok: { id: field(created.data, "id") ?? "" } };
  } catch (error) {
    return failure(error);
  }
}

/** Add a region type — the Administrative Divisions tab (§4.4). Its key is permanent. */
export async function createDivisionAction(
  input: CreateDivisionInput,
  resume?: Resume,
): Promise<WriteResult> {
  const parsed = createDivisionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { key, name } = parsed.data;

  try {
    const created = await step(
      "region_type.create",
      { body: { key, name } },
      "create",
      resume,
      {},
    );
    if (stopped(created)) return created;
    // A region type's identity is its key; RDB answers the UnitType, which has no id.
    return { ok: { id: key } };
  } catch (error) {
    return failure(error);
  }
}

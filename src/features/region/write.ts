import "server-only";
import { getTranslations } from "next-intl/server";
import { ApiError, SessionLockedError } from "@/lib/api/server";
import { commandOrRetry, type CommandOutcome } from "@/lib/api/operations";
import { apiErrorSchema } from "@/lib/auth/endpoints";
import { correlationId, errorCode, retryAfterSeconds } from "@/lib/auth/errors";

/*
 * The machinery every RDB write shares — the geography, currency and language
 * Server Actions (`backend docs/project-data/from-backend/2026-10-30-rdb-screens.md` §2.2,
 * `2026-10-31-answers-flags-uploads-retry.md` for retries). Not a `"use server"`
 * file on purpose: everything exported from one of those is callable from the
 * browser, and these are building blocks, not actions.
 *
 * Every action answers the same `WriteResult`:
 *
 *   ok        the id RDB gave the new thing — and, after an edit, its new
 *             `updatedAt`, which the next edit sends back (answers 2026-11-05 §2).
 *   pending   a command came back UNKNOWN — it may or may not have happened.
 *             Never shown as a failure: the form keeps it and the SAME
 *             button sends it back, which retries that command instead of
 *             sending a second one.
 *   carry     an error, but some steps already went through (a flag uploaded,
 *             a country created): the next press picks up after them rather
 *             than doing them twice.
 *   locked    the session wants the PIN (SessionLockedError); nothing was sent.
 *   error     one translated line. RDB's own refusals are shown as RDB worded
 *             them (§2.3: "show `message` as it is").
 *   fields    RDB's per-field messages (`name.fa`), for the row they belong to.
 *   closed    the country was closed meanwhile (`404 COUNTRY_NOT_FOUND` on an
 *             edit, and `country.get` says so): the screen shows it closed.
 *   fresh     `409 STALE_UPDATE`: the record as it is now, so the form shows
 *             the new values and the next save is a new request.
 */

/** Where a multi-step write picks up on the next press. */
export type Resume = {
  /** An UNKNOWN command to retry rather than send again. */
  commandId?: string;
  /** Which step `commandId` belongs to. */
  step?: "upload" | "create" | "levels" | "update" | "currency" | "close" | "reopen" | "status";
  /** The flag already uploaded — reused, never uploaded twice. */
  flagUrl?: string;
  /** The country already created (or updated) — only the steps after it are left. */
  countryId?: string;
  /** Its levels are set too — only the currency is left. */
  levelsDone?: boolean;
};

export type WriteResult = {
  ok?: { id: string; updatedAt?: string };
  pending?: Resume;
  carry?: Resume;
  locked?: true;
  error?: string;
  fields?: Record<string, string>;
  closed?: true;
  fresh?: unknown;
};

export const field = (data: unknown, name: string) =>
  typeof data === "object" && data !== null && typeof (data as Record<string, unknown>)[name] === "string"
    ? ((data as Record<string, unknown>)[name] as string)
    : undefined;

/** The refusals RDB asks us to explain: what to do, then RDB's own words. */
const EXPLAINED: Record<
  string,
  | "stale"
  | "codeInUse"
  | "hasChildren"
  | "regionNotEmpty"
  | "countryClosed"
  | "languageExists"
  | "languageRequired"
  | "languageFallback"
  | "languageNotFound"
> = {
  STALE_UPDATE: "stale",
  COUNTRY_CODE_IN_USE: "codeInUse",
  UNIT_HAS_ACTIVE_CHILDREN: "hasChildren",
  REGION_NOT_EMPTY: "regionNotEmpty",
  COUNTRY_NOT_FOUND: "countryClosed",
  LANGUAGE_EXISTS: "languageExists",
  LANGUAGE_REQUIRED: "languageRequired",
  LANGUAGE_FALLBACK_INVALID: "languageFallback",
  LANGUAGE_NOT_FOUND: "languageNotFound",
};

export async function failure(error: unknown, carry?: Resume): Promise<WriteResult> {
  if (error instanceof SessionLockedError) return { locked: true, carry };

  const t = await getTranslations("region.errors");
  const code = errorCode(error);
  const result = (message: string, fields?: Record<string, string>): WriteResult => ({
    error: message,
    carry,
    ...(fields ? { fields } : {}),
  });

  if (code === "COMMAND_RETRY_EXPIRED") return result(t("retryExpired"));
  // Only a retry answers this: the command already finished one way or the other.
  if (code === "PRECONDITION_FAILED") return result(t("retryFinished"));
  if (code === "RATE_LIMITED") {
    return result(t("rateLimited", { seconds: retryAfterSeconds(error) ?? 60 }));
  }

  const body = apiErrorSchema.safeParse(error instanceof ApiError ? error.body : undefined);
  if (body.success) {
    const { message, fields } = body.data.error;
    const detail = fields ? Object.values(fields).join(" · ") : "";
    const rdb = detail ? `${message}: ${detail}` : message;
    const explained = code ? EXPLAINED[code] : undefined;
    return result(explained ? `${t(explained)} ${rdb}` : rdb, fields);
  }
  return result(t("generic", { ref: correlationId(error) ?? "—" }));
}

export async function invalid(issues: { path: PropertyKey[] }[]): Promise<WriteResult> {
  const t = await getTranslations("region.errors");
  const fields = [...new Set(issues.map((i) => String(i.path[0])))];
  return { error: t("invalid", { fields: fields.join(", ") }) };
}

/**
 * Run one step (or retry it, when the last press left it UNKNOWN). Answers its
 * `data`, or the `pending` result that stops the write here.
 */
export async function step(
  name: string,
  input: Parameters<typeof commandOrRetry>[1],
  at: NonNullable<Resume["step"]>,
  resume: Resume | undefined,
  keep: Omit<Resume, "commandId" | "step">,
): Promise<{ data: unknown } | WriteResult> {
  let outcome: CommandOutcome;
  try {
    outcome = await commandOrRetry(name, input, resume?.step === at ? resume.commandId : undefined);
  } catch (error) {
    // Which operation RDB refused, and the reference that finds it on their
    // side — the screen shows only RDB's message, and a multi-step save
    // (create → levels → currency) does not say which step that was.
    if (!(error instanceof SessionLockedError)) {
      console.warn(
        `[rdb] ${name} refused: ${error instanceof ApiError ? error.status : "?"} ` +
          `${errorCode(error) ?? "-"} (ref ${correlationId(error) ?? "-"})`,
      );
    }
    throw error;
  }
  if (outcome.status === "UNKNOWN") {
    return { pending: { commandId: outcome.commandId, step: at, ...keep } };
  }
  return { data: outcome.data };
}

export const stopped = (r: { data: unknown } | WriteResult): r is WriteResult => !("data" in r);

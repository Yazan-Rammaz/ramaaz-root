"use server";

import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { backendFetch } from "@/lib/api/backend";
import { commandOrRetry, oneParam } from "@/lib/api/operations";
import { getMemberVerification } from "./api";
import { ApiError, SessionLockedError } from "@/lib/api/server";
import { apiErrorSchema } from "@/lib/auth/endpoints";
import { correlationId, errorCode, retryAfterSeconds } from "@/lib/auth/errors";
import {
  getStartedSchema,
  idSchema,
  levelSchema,
  newMemberSchema,
  photoDataUrlSchema,
  policyInputSchema,
  secretWordsSchema,
  settingsInputSchema,
  type GetStartedInput,
  type Level,
  type NewMember,
  type PolicyInput,
  type SettingsInput,
  type VerificationSummary,
} from "./schema";

/*
 * The work structure's writes — the root backend's routes under
 * `/v1/projects/{id}` (console-api.md §5.8–§5.14). Every one answers a
 * `WorkResult`, and the screen reads the page again (`router.refresh()`) on
 * `ok`: a person's state is spread over several reads, so the page puts it
 * back together rather than this guessing it.
 *
 *   ok        it was done. `pending`: it waits for the other root (a `202`).
 *             `notice`: one line to say what happened (sent, not delivered…).
 *   fields    `422 VALIDATION_FAILED`, one message per input, keyed as the request.
 *   reload    what was shown has moved underneath — read it again.
 *   locked    the session wants the PIN; nothing was sent.
 *   error     one line for the whole action.
 */
export type WorkResult = {
  ok?: true;
  pending?: true;
  /** Added: the new account's id. */
  userId?: string;
  /** Added, but the backend did not take the secret words yet: keep them for Send Login Info. */
  wordsInTab?: true;
  /** An RDB command that came back UNKNOWN: the next press retries it instead of sending another. */
  commandId?: string;
  notice?: string;
  fields?: Record<string, string>;
  reload?: true;
  locked?: true;
  error?: string;
};

const enc = encodeURIComponent;

/** Codes whose own sentence is ours; every other refusal shows the backend's message. */
const NAMED = {
  APPROVAL_SELF: "approvalSelf",
  APPROVAL_PAYLOAD_CHANGED: "approvalChanged",
  APPROVAL_STALE: "approvalStale",
  APPROVAL_EXPIRED: "approvalExpired",
  APPROVAL_CLOSED: "approvalClosed",
  APPROVAL_PENDING: "approvalPending",
  ALREADY_EXISTS: "alreadyExists",
  UNIT_ADMIN_LIMIT: "unitFull",
  SERVICE_UNAVAILABLE: "unavailable",
  STALE_UPDATE: "stale",
} as const;
// `SETTINGS_SET_FROM_ABOVE` (RDB 1.21): only a level above may change these settings; its message says so.
const RELOAD = new Set([
  "APPROVAL_PAYLOAD_CHANGED",
  "APPROVAL_STALE",
  "APPROVAL_CLOSED",
  "APPROVAL_EXPIRED",
  "STALE_UPDATE",
  "SETTINGS_SET_FROM_ABOVE",
]);

async function failure(error: unknown, what = "write"): Promise<WorkResult> {
  if (error instanceof SessionLockedError) return { locked: true };
  console.warn(
    `[work-structure] ${what} refused: status=${error instanceof ApiError ? error.status : "-"} code=${errorCode(error) ?? "-"} correlation_id=${correlationId(error) ?? "-"} detail=${error instanceof Error ? error.message : String(error)}`,
  );
  const t = await getTranslations("work.errors");
  const code = errorCode(error);
  const status = error instanceof ApiError ? error.status : 0;
  const body = apiErrorSchema.safeParse(error instanceof ApiError ? error.body : undefined);
  const detail = body.success ? body.data.error : undefined;

  if (code === "RATE_LIMITED") return { error: t("rateLimited", { seconds: retryAfterSeconds(error) ?? 60 }) };
  if (code && code in NAMED) {
    const key = NAMED[code as keyof typeof NAMED];
    return { error: t(key), ...(RELOAD.has(code) ? { reload: true as const } : {}) };
  }
  // A refusal in the backend's own words that also means "what you see moved".
  if (code && RELOAD.has(code) && detail?.message) return { error: detail.message, reload: true };
  if (status === 422 && detail?.fields && Object.keys(detail.fields).length) {
    return { fields: detail.fields, error: detail.message };
  }
  if (status === 403) return { error: detail?.message ?? t("forbidden") };
  if (status === 404) return { error: t("gone"), reload: true };
  if (detail?.message) return { error: detail.message };
  return { error: t("generic", { ref: correlationId(error) ?? "—" }) };
}

async function invalid(): Promise<WorkResult> {
  return { error: (await getTranslations("work.errors"))("invalid") };
}

/* ───────────────────────────── Members ───────────────────────────── */

const addedSchema = z
  .object({ user: z.object({ id: z.string() }).loose(), approval: z.unknown().optional() })
  .loose();

/**
 * Add Business Admin (§5.8): the account and its roles here, in one step.
 * They are this level's admin, so they also MANAGE it — at the head office
 * that makes them the project's general manager, which takes both roots: the
 * answer is `202` and they hold nothing until the other root approves (§5.11).
 *
 * The photo goes up after, on its own route (§5.9) — never inside the member.
 * Its failure does not undo the member: the screen asks for it again before
 * Send Login Info.
 */
export async function addMemberAction(level: Level, input: NewMember, photo?: string): Promise<WorkResult> {
  const where = levelSchema.safeParse(level);
  const member = newMemberSchema.safeParse(input);
  const picture = photo === undefined ? undefined : photoDataUrlSchema.safeParse(photo);
  if (!where.success || !member.success || (picture && !picture.success)) return invalid();

  const { roles, secret_words, ...account } = member.data;
  const post = (words?: string) =>
    backendFetch
      .post<unknown>("/members", {
        ...account,
        ...(words ? { secret_words: words } : {}),
        assignments: [{ unit: where.data, roles }],
        manages: [where.data],
      })
      .then((raw) => addedSchema.parse(raw));
  let added: z.infer<typeof addedSchema>;
  let wordsInTab = false;
  try {
    try {
      // The words are stored with the account and sent by Get Started (§5.10).
      added = await post(secret_words);
    } catch (error) {
      // ⏳ A backend that does not take them yet refuses the field: add without
      // them, and Send Login Info carries them as before.
      const fields = error instanceof ApiError ? apiErrorSchema.safeParse(error.body) : null;
      if (!secret_words || !fields?.success || !fields.data.error.fields?.secret_words) throw error;
      added = await post();
      wordsInTab = true;
    }
  } catch (error) {
    return failure(error, "POST /members");
  }

  const t = await getTranslations("work.notices");
  const pending = added.approval != null ? ({ pending: true } as const) : {};
  let hasPhoto = false;
  if (picture?.success) {
    try {
      await backendFetch.put<unknown>(`/members/${enc(added.user.id)}/photo`, { photo: picture.data });
      hasPhoto = true;
    } catch (error) {
      if (error instanceof SessionLockedError) return { ok: true, ...pending, userId: added.user.id, locked: true };
      return { ok: true, ...pending, userId: added.user.id, notice: t("photoLater") };
    }
  }
  if (pending.pending) {
    return {
      ok: true,
      ...pending,
      userId: added.user.id,
      ...(wordsInTab ? { wordsInTab: true as const } : {}),
      notice: t("waitingOtherRoot"),
    };
  }
  // In effect at once: the login information goes now (see sendLoginInfo).
  let notice: string | undefined;
  try {
    notice = await sendLoginInfo(added.user.id, where.data, { hasPhoto, words: wordsInTab ? secret_words : undefined });
  } catch {
    return { ok: true, userId: added.user.id, locked: true };
  }
  return { ok: true, userId: added.user.id, notice };
}

/** Replace a member's reference photograph — the one their face is compared with at every sign-in. */
export async function setMemberPhotoAction(userId: string, photo: string): Promise<WorkResult> {
  const id = idSchema.safeParse(userId);
  const picture = photoDataUrlSchema.safeParse(photo);
  if (!id.success || !picture.success) return invalid();
  try {
    await backendFetch.put<unknown>(`/members/${enc(id.data)}/photo`, { photo: picture.data });
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

const startedSchema = z
  .object({
    phone: z.string().optional(),
    delivered: z.boolean().optional(),
    secret_words_sent: z.boolean().optional(),
    /** No WhatsApp template for the words yet: kept, sent by a later Get Started. */
    secret_words_pending: z.boolean().optional(),
  })
  .loose();

/*
 * Send the login information on its own (2026-11-24): nobody presses Send Login
 * Info any more. Right after an appointment that takes effect at once (a
 * manager's), and right after the second root approves one that waited (the
 * head office's). The level's own policy says which contract to issue — the one
 * its Setting tab chose — and whether a photo has to be there first; the secret
 * words were stored on Add. If it cannot go (a required photo missing, the
 * message refused), the notice says so and Send Login Info is still there.
 */
const autoPolicySchema = z
  .object({
    effective: z
      .object({
        require_contract: z.boolean().nullable().optional(),
        contract_types: z.array(z.string()).nullable().optional(),
        require_face: z.boolean().nullable().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
async function sendLoginInfo(userId: string, level: Level, opts: { hasPhoto: boolean; words?: string }): Promise<string | undefined> {
  const t = await getTranslations("work.notices");
  try {
    const path = level === null ? "/dashboard-policy" : `/units/${enc(level)}/dashboard-policy`;
    const policy = autoPolicySchema.parse(await backendFetch.get<unknown>(path)).effective;
    if (policy?.require_face && !opts.hasPhoto) return t("photoLater");
    const contract = policy?.require_contract ? policy.contract_types?.[0] : undefined;
    const sent = startedSchema.parse(
      await backendFetch.post<unknown>(`/members/${enc(userId)}/get-started`, {
        ...(contract ? { contract_type: contract } : {}),
        ...(opts.words ? { secret_words: opts.words } : {}),
      }),
    );
    return sent.delivered === false
      ? t("notDelivered", { phone: sent.phone ?? "" })
      : sent.secret_words_pending
        ? t("wordsPending")
        : t("sent", { phone: sent.phone ?? "" });
  } catch (error) {
    if (error instanceof SessionLockedError) throw error;
    console.warn(
      `[work-structure] automatic Get Started not sent: ${error instanceof ApiError ? error.status : "-"} ${errorCode(error) ?? "-"} ${error instanceof Error ? error.message : String(error)}`,
    );
    return t("sendByHand");
  }
}

/**
 * Send Login Info (Get Started, §5.8): the link and the private code by
 * WhatsApp, with the secret words and the contract to sign when chosen.
 */
export async function getStartedAction(userId: string, input: GetStartedInput): Promise<WorkResult> {
  const id = idSchema.safeParse(userId);
  const body = getStartedSchema.safeParse(input);
  if (!id.success || !body.success) return invalid();
  try {
    const sent = startedSchema.parse(await backendFetch.post<unknown>(`/members/${enc(id.data)}/get-started`, body.data));
    const t = await getTranslations("work.notices");
    return {
      ok: true,
      notice:
        sent.delivered === false
          ? t("notDelivered", { phone: sent.phone ?? "" })
          : sent.secret_words_pending
            ? t("wordsPending")
            : t("sent", { phone: sent.phone ?? "" }),
    };
  } catch (error) {
    return failure(error);
  }
}

/** Set or change the secret words. Sends nothing — the person is told by whoever set them. */
export async function setSecretWordsAction(userId: string, words: string): Promise<WorkResult> {
  const id = idSchema.safeParse(userId);
  const value = secretWordsSchema.safeParse(words);
  if (!id.success || !value.success) return invalid();
  try {
    await backendFetch.put<unknown>(`/members/${enc(id.data)}/secret-words`, { secret_words: value.data });
    return { ok: true, notice: (await getTranslations("work.notices"))("wordsSaved") };
  } catch (error) {
    return failure(error);
  }
}

/** Back to the shared phrase. */
export async function removeSecretWordsAction(userId: string): Promise<WorkResult> {
  const id = idSchema.safeParse(userId);
  if (!id.success) return invalid();
  try {
    await backendFetch.delete<unknown>(`/members/${enc(id.data)}/secret-words`);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/* ───────────────────────────── Approvals ───────────────────────────── */

const reasonSchema = z.string().trim().max(500).optional();

/**
 * Decide a general-manager appointment (§5.11). Approve sends back the hash of
 * the request that was SHOWN — the approval is of exactly that; Withdraw is
 * the asking root's.
 */
export async function decideAppointmentAction(
  approvalId: string,
  decision: "approve" | "refuse" | "withdraw",
  extra: { payloadHash?: string; reason?: string; targetId?: string; level?: Level } = {},
): Promise<WorkResult> {
  const id = idSchema.safeParse(approvalId);
  const reason = reasonSchema.safeParse(extra.reason);
  if (!id.success || !reason.success || (decision === "approve" && !extra.payloadHash)) return invalid();
  const body =
    decision === "approve"
      ? { payload_hash: extra.payloadHash }
      : decision === "refuse" && reason.data
        ? { reason: reason.data }
        : undefined;
  try {
    await backendFetch.post<unknown>(`/approvals/${enc(id.data)}/${decision}`, body);
    // Approved: the login information goes now, as for any appointment in effect
    // (see sendLoginInfo). The photo was set on Add; the policy decides if needed.
    const target = extra.targetId ? idSchema.safeParse(extra.targetId) : null;
    if (decision === "approve" && target?.success) {
      const notice = await sendLoginInfo(target.data, extra.level ?? null, { hasPhoto: true });
      return { ok: true, notice };
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Let a first sign-in in, or end it (§5.12). */
export async function decideLoginAction(
  approvalId: string,
  decision: "approve" | "refuse",
  reason?: string,
): Promise<WorkResult> {
  const id = idSchema.safeParse(approvalId);
  const why = reasonSchema.safeParse(reason);
  if (!id.success || !why.success) return invalid();
  try {
    await backendFetch.post<unknown>(
      `/login-approvals/${enc(id.data)}/${decision}`,
      decision === "refuse" && why.data ? { reason: why.data } : undefined,
    );
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/* ───────────────────────────── Sign-in policy ───────────────────────────── */

/** A level's COMPLETE own settings (§5.14); `null` is "inherit". */
export async function savePolicyAction(level: Level, input: PolicyInput): Promise<WorkResult> {
  const where = levelSchema.safeParse(level);
  const policy = policyInputSchema.safeParse(input);
  if (!where.success || !policy.success) return invalid();
  const path = where.data === null ? "/dashboard-policy" : `/units/${enc(where.data)}/dashboard-policy`;
  try {
    await backendFetch.put<unknown>(path, policy.data);
    return { ok: true, notice: (await getTranslations("work.notices"))("policySaved") };
  } catch (error) {
    return failure(error);
  }
}

/* ───────────────────────────── Data Setting ───────────────────────────── */

/**
 * A level's COMPLETE data settings, to RDB (2026-11-17-business-structure-page.md
 * §3): `project.settings.update` for the head office, `unit.settings.update`
 * for a unit, with the `updatedAt` it was read at. Someone else saved in
 * between → `409 STALE_UPDATE`, read again. RDB's `409 SETTING_OUTSIDE_PARENT`,
 * `409 SETTING_IN_USE_BELOW` and `422 SETTING_NOT_USABLE` carry their own
 * sentence. The head office's financial check can leave it UNKNOWN: "not
 * confirmed", and the next press retries that same command.
 */
export async function saveDataSettingsAction(
  level: Level,
  input: SettingsInput,
  pendingCommandId?: string,
): Promise<WorkResult> {
  const where = levelSchema.safeParse(level);
  const body = settingsInputSchema.safeParse(input);
  if (!where.success || !body.success) return invalid();
  try {
    const outcome =
      where.data === null
        ? await commandOrRetry("project.settings.update", { body: body.data }, pendingCommandId)
        : await commandOrRetry(
            "unit.settings.update",
            { params: await oneParam("unit.settings.update", where.data, "unit_id"), body: body.data },
            pendingCommandId,
          );
    if (outcome.status === "UNKNOWN") {
      return { error: (await getTranslations("work.errors"))("notConfirmed"), commandId: outcome.commandId };
    }
    return { ok: true, notice: (await getTranslations("work.notices"))("dataSaved") };
  } catch (error) {
    return failure(error, "data settings");
  }
}

/* ───────────────────────────── One member ───────────────────────────── */

const memberEditSchema = z.object({
  full_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(5).max(32).optional(),
});

/**
 * Change a member's name or phone (§5.8a). A new phone ends every session
 * they have and is confirmed at their next sign-in; nothing is sent.
 */
export async function updateMemberAction(userId: string, input: { full_name?: string; phone?: string }): Promise<WorkResult> {
  const id = idSchema.safeParse(userId);
  const body = memberEditSchema.safeParse(input);
  if (!id.success || !body.success) return invalid();
  try {
    const r = z
      .object({ phone_changed: z.boolean().optional() })
      .loose()
      .parse(await backendFetch.patch<unknown>(`/members/${enc(id.data)}`, body.data));
    const t = await getTranslations("work.notices");
    return { ok: true, notice: r.phone_changed ? t("phoneChanged") : t("memberSaved") };
  } catch (error) {
    return failure(error, "PATCH /members");
  }
}

export type SecretWordsRead = {
  has?: boolean;
  readable?: boolean;
  words?: string | null;
  setAt?: string | null;
  locked?: true;
  error?: string;
};

/** Read a member's secret words (§5.10) — only on Show: every read is recorded. */
export async function readSecretWordsAction(userId: string): Promise<SecretWordsRead> {
  const id = idSchema.safeParse(userId);
  if (!id.success) return { error: (await getTranslations("work.errors"))("invalid") };
  try {
    const r = z
      .object({
        has_secret_words: z.boolean(),
        readable: z.boolean().optional(),
        secret_words: z.string().nullable().optional(),
        set_at: z.string().nullable().optional(),
      })
      .loose()
      .parse(await backendFetch.get<unknown>(`/members/${enc(id.data)}/secret-words`));
    return { has: r.has_secret_words, readable: r.readable, words: r.secret_words, setAt: r.set_at };
  } catch (error) {
    const f = await failure(error, "GET secret-words");
    return { locked: f.locked, error: f.error };
  }
}

/** Where one person's roles take effect (§5.10a): every country, or the country units picked. Root only. */
export async function saveMemberCountriesAction(userId: string, all: boolean, countries: string[]): Promise<WorkResult> {
  const id = idSchema.safeParse(userId);
  const ids = z.array(idSchema).max(300).safeParse(countries);
  if (!id.success || !ids.success) return invalid();
  try {
    await backendFetch.put<unknown>(`/members/${enc(id.data)}/countries`, {
      all_countries: all,
      countries: all ? [] : ids.data,
    });
    return { ok: true };
  } catch (error) {
    return failure(error, "PUT member countries");
  }
}

/** The roles a level may give (§5.14a): all, or the ids switched on. */
export async function saveLevelRolesAction(level: Level, all: boolean, roles: string[]): Promise<WorkResult> {
  const where = levelSchema.safeParse(level);
  const ids = z.array(idSchema).max(200).safeParse(roles);
  if (!where.success || !ids.success) return invalid();
  const path = where.data === null ? "/level-roles" : `/units/${enc(where.data)}/level-roles`;
  try {
    await backendFetch.put<unknown>(path, all ? { all_roles: true } : { all_roles: false, roles: ids.data });
    return { ok: true };
  } catch (error) {
    return failure(error, "PUT level-roles");
  }
}

/**
 * Which verification pictures a member has, and what was read off their
 * document (`GET …/members/{id}/verification`) — for the Files tab, read when
 * it opens (every read is audited). The URLs stay on the server: the images
 * come through `/api/work-image?verification=…`.
 */
export async function readVerificationAction(userId: string): Promise<{ data?: VerificationSummary; locked?: true; error?: string }> {
  const id = idSchema.safeParse(userId);
  if (!id.success) return { error: (await getTranslations("work.errors"))("invalid") };
  try {
    const v = await getMemberVerification(id.data);
    return {
      data: {
        reference: !!v.reference_photo_url,
        capture: v.face_capture
          ? { has: !!v.face_capture.image_url, at: v.face_capture.captured_at, purged: !!v.face_capture.purged }
          : null,
        document: v.document
          ? {
              type: v.document.type,
              front: !!v.document.front_image_url,
              back: !!v.document.back_image_url,
              extracted: v.document.extracted,
              submittedAt: v.document.submitted_at,
              purged: !!v.document.purged,
            }
          : null,
      },
    };
  } catch (error) {
    const f = await failure(error, "GET verification");
    return { locked: f.locked, error: f.error };
  }
}

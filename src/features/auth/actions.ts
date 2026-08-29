"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/api/server";
import {
  applyStage,
  clearChallenge,
  readChallenge,
  UnknownStageError,
} from "@/lib/auth/challenge";
import { clearAuthCookies } from "@/lib/auth/cookies";
import {
  AUTH_PATHS,
  deviceOptionsResponseSchema,
  stepResponseSchema,
  type DeviceRequest,
  type EvidenceRequest,
  type PrivateCodeRequest,
} from "@/lib/auth/endpoints";
import { isChallengeDead, signInError } from "@/lib/auth/errors";
import { privateCodeSchema } from "./schema";

/**
 * Server Actions are THE one way the browser triggers a mutation.
 *
 * Every step of sign-in has the same three beats: validate the input, exchange
 * it with the backend, and hand the answer to `applyStage()`. None of them
 * decides what comes next — the server does, and `applyStage` obeys it. That is
 * what makes a check being switched on or off backend-side a non-event here.
 *
 * Paths and response shapes live in `lib/auth/endpoints.ts`; the routing table
 * lives in `lib/auth/challenge.ts`. Neither belongs at a call site.
 */
export type ActionState = {
  ok: boolean;
  error?: string;
  /**
   * The challenge is dead — expired, spent, or burned by too many failures.
   * The screen must stop offering "try again" and send them back to their
   * access link, because no retry of this step can now succeed.
   */
  restart?: boolean;
};

/**
 * Step 2 — the private code the administrator pulled over WhatsApp.
 *
 * There is no companion "resend" action, and that is not an omission: no
 * endpoint sends this code. The administrator messages the number again
 * themselves. A code the console could request on somebody's behalf would prove
 * nothing about who is holding the link, which is the entire point of the step.
 */
export async function submitPrivateCodeAction(
  code: string,
): Promise<ActionState> {
  const parsed = privateCodeSchema.safeParse({ code });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  const challenge = await readChallenge();
  if (!challenge.challengeToken) redirect("/login");

  let result;
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.privateCode, {
      challenge_token: challenge.challengeToken,
      code: parsed.data.code,
    } satisfies PrivateCodeRequest);

    result = stepResponseSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    if (error instanceof UnknownStageError) {
      return { ok: false, error: error.message };
    }
    // A wrong code costs one of five attempts across the whole sequence and
    // alerts the other root administrators — somebody holding a link and
    // guessing is the shape of a forwarded link. It is still just a retry.
    // A dead challenge is not: only a fresh start recovers.
    return {
      ok: false,
      error: signInError(error, "That code is not correct"),
      restart: isChallengeDead(error),
    };
  }

  // Outside the try — applyStage() redirects by throwing, and a call inside
  // would be caught above and the navigation swallowed.
  return applyStage(result);
}

/**
 * Stage 3 — the live face check.
 *
 * The frame arrives already gated: `useFaceGate` will not release one until a
 * single face is present, centred, facing the camera, lit, sharp and still. So
 * a rejection here is a real mismatch, not a bad photograph — which matters,
 * because the backend counts failures against a challenge that tolerates five
 * in total and then kills the session itself. The frontend deliberately keeps
 * no attempt counter of its own: two authorities disagreeing about how many
 * tries remain is worse than one.
 *
 * The image goes to the KYC Worker, never to the auth backend — see
 * `docs/kyc-integration.md`. What reaches `/v1/auth/face` is the Worker's
 * signed verdict, so no biometric ever touches the auth path.
 */
export async function submitFaceAction(stepToken: string): Promise<ActionState> {
  if (!stepToken) return { ok: false, error: "No verification proof" };

  const challenge = await readChallenge();
  if (!challenge.challengeToken) redirect("/no-access");

  let result;
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.face, {
      challenge_token: challenge.challengeToken,
      // Shape settled with the backend: the face image never reaches it, so
      // this carries the Worker's verdict rather than pixels. Until the Worker
      // commit path exists, the frame is what there is to send.
      // The Worker's verdict, not pixels. It minted this after comparing the
      // live face against the stored photo and committing the scores over its
      // own signed channel — so the backend can trust it without ever seeing an
      // image, which is why no biometric touches the auth path.
      evidence: { step_token: stepToken },
    } satisfies EvidenceRequest);

    result = stepResponseSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    if (error instanceof UnknownStageError) {
      return { ok: false, error: error.message };
    }
    return {
      ok: false,
      error: signInError(error, "That did not match. Try again."),
      restart: isChallengeDead(error),
    };
  }

  // Outside the try — applyStage() redirects by throwing.
  return applyStage(result);
}

/**
 * The evidence the document step will take, ONCE `/v1/kyc/submit` exists.
 *
 * Identical in shape to the face step, and for the same reason: the image goes
 * to the KYC Worker, the Worker commits what it measured over its own signed
 * channel, the backend mints a single-use token, and only that token is posted
 * here. No biometric and no government document touches the auth path.
 *
 * Nothing mints one yet — see `StubDocumentEvidence` below.
 */
export type DocumentStepTokenEvidence = { step_token: string };

/**
 * ⚠️ INTERIM. The base64 payload the stub accepts today, and a dead end.
 *
 * `root-enrollment.md` §5 is unambiguous that this path is going away: *"do not
 * build against the payload below… What you must not build is a path that posts
 * base64 images to /auth/identity-document, because that path is going away."*
 * The document step will become `{ step_token }` — one line identical to the
 * face step — as soon as `POST /v1/kyc/submit` is built to mint one.
 *
 * It is still sent, deliberately and narrowly: the stub exists, in the doc's
 * own words, "kept only so the sequence can be walked end to end", and without
 * it the flow dead-ends at ID_DOCUMENT_REQUIRED and the device step cannot be
 * reached or tested at all. That is the whole justification — walking the
 * sequence. It is NOT a contract, the field names below were never agreed, and
 * a green run proves only that a stub accepts any object with one key.
 *
 * ── Removing this ───────────────────────────────────────────────────────────
 * When `/v1/kyc/submit` lands, delete this type and change the ONE call site in
 * `IdentityStep.tsx` to pass `{ step_token }`. The action already accepts both
 * — that is what the union below is for — so nothing here needs to change.
 */
export type StubDocumentEvidence = {
  document_type: "NATIONAL_ID" | "PASSPORT" | "DRIVING_LICENSE";
  /** Data URLs. `back` is absent for a passport — one page, no reverse. */
  front: string;
  back?: string;
  /** The frame captured at the face step, reused rather than re-shot. */
  selfie?: string;
  /** Read off the document by the Worker's OCR. */
  full_name?: string;
  document_number?: string;
  birth_date?: string;
  expiry_date?: string;
  country?: string;
  country_iso3?: string;
  /** What the Worker measured comparing that selfie to the document photo. */
  selfie_vs_id_score?: number;
  liveness_confidence?: number;
};

/**
 * Either shape. The union is the migration: both compile, both post, and the
 * switch is made at the call site rather than by rewriting this file.
 */
export type IdentityDocumentEvidence =
  | DocumentStepTokenEvidence
  | StubDocumentEvidence;

/**
 * Stage 4 — first-login ID enrolment, and the LAST step before the device.
 *
 * ── Nothing here starts a KYC session ───────────────────────────────────────
 * Root has no session concept at all: the challenge carries the flow from
 * `/auth/link` to the tokens, and `challenge_id` is what identifies it to the
 * Worker. The KYC Worker's own `/submit` route — three uploads to
 * `/media/upload/direct`, a country lookup against `/countries`, then URLs to
 * `/kyc/submit` — is RDB's contract, and all three answer 404 here. Its first
 * symptom was this flow dying on "session start failed: Unauthorized", because
 * the Worker's `/session` is guarded by an access token that does not exist
 * mid sign-in.
 *
 * ── This step is mid-migration ──────────────────────────────────────────────
 * Today it posts the stub's base64 payload; tomorrow it posts
 * `{ step_token }`, exactly like `/auth/face`. See the evidence types above for
 * why, and for what changes when `/v1/kyc/submit` is built. This function is
 * indifferent to which — it forwards whatever it is handed.
 *
 * The response advances to DEVICE_REQUIRED, so `applyStage` sends the browser
 * to the passkey ceremony — the step that actually binds the account.
 */
export async function submitIdentityDocumentAction(
  evidence: IdentityDocumentEvidence,
): Promise<ActionState> {
  // Guards the one field each shape cannot be useful without, so an empty
  // payload fails here rather than spending an attempt against the challenge —
  // it tolerates five across all steps before burning.
  const empty =
    "step_token" in evidence ? !evidence.step_token : !evidence.front;
  if (empty) return { ok: false, error: "No document evidence" };

  const challenge = await readChallenge();
  if (!challenge.challengeToken) redirect("/no-access");

  let result;
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.identityDocument, {
      challenge_token: challenge.challengeToken,
      // Undefined keys are dropped by JSON.stringify, so a passport simply
      // arrives without `back` rather than with an explicit null the stub
      // would have to interpret.
      evidence: { ...evidence },
    } satisfies EvidenceRequest);

    result = stepResponseSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    if (error instanceof UnknownStageError) {
      return { ok: false, error: error.message };
    }
    return {
      ok: false,
      error: signInError(error, "That document could not be enrolled. Try again."),
      restart: isChallengeDead(error),
    };
  }

  // Outside the try — applyStage() redirects by throwing.
  return applyStage(result);
}

/**
 * Abandon a half-finished sign-in.
 *
 * The only recovery from a burned challenge. It does not "retry" anything: the
 * administrator must open their access link again, because that is the only
 * thing that can open a new challenge.
 */
export async function restartSignInAction(): Promise<void> {
  await clearChallenge();
  redirect("/login");
}

export async function logoutAction() {
  try {
    await api.post(AUTH_PATHS.logout);
  } catch {
    // Best-effort server-side revoke; clear local cookies regardless.
  }
  await clearAuthCookies();
  await clearChallenge();
  // Through the splash → it re-checks (now unauthenticated) and lands on /login.
  redirect("/");
}

/* ─────────────────────────── the passkey ─────────────────────────── */

/**
 * Stage 4a — ask the server for the WebAuthn ceremony.
 *
 * Returns only the `publicKey` block and which browser call to make. The
 * challenge token stays here, in the action: a component driving
 * `navigator.credentials` never sees a credential of ours, which is what keeps
 * this inside the BFF rule even though the ceremony must run in the browser.
 *
 * ⚠️ `mode` is the SERVER's decision, from what this link has already enrolled.
 * Never pick it client-side — that is precisely what stops a stranger asking to
 * "register" on a link that is already bound to somebody's device.
 */
export async function deviceOptionsAction(): Promise<
  ActionState & { mode?: "register" | "authenticate"; publicKey?: Record<string, unknown> }
> {
  const challenge = await readChallenge();
  if (!challenge.challengeToken) redirect("/no-access");

  try {
    const raw = await api.post<unknown>(AUTH_PATHS.deviceOptions, {
      challenge_token: challenge.challengeToken,
    });
    const result = deviceOptionsResponseSchema.parse(raw);
    return { ok: true, mode: result.mode, publicKey: result.publicKey };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    return {
      ok: false,
      error: signInError(error, "Could not start device verification"),
      restart: isChallengeDead(error),
    };
  }
}

/**
 * Stage 4b — submit the ceremony's answer.
 *
 * On a first login this binds the access link to this passkey **permanently**:
 * from here the link opens from this device and no other. There is no recovery
 * from losing it — only another root administrator issuing a fresh link — so
 * this is the single least reversible action in the whole flow.
 *
 * `label` is stored here (the one sent to `/device/options` is ignored) and is
 * what the administrator sees in their credential list.
 */
export async function submitDeviceAction(
  credential: Record<string, unknown>,
  label: string,
): Promise<ActionState> {
  const challenge = await readChallenge();
  if (!challenge.challengeToken) redirect("/no-access");

  let result;
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.device, {
      challenge_token: challenge.challengeToken,
      label,
      credential,
    } satisfies DeviceRequest);

    // The SHAPE of the final response, keys only.
    //
    // This is the one step that ends in tokens, and if they do not arrive where
    // the schema expects them the sign-in dies at the last inch with "COMPLETED
    // without issuing tokens" — after the passkey has been created and the
    // server considers the account enrolled. Zod strips unknown keys, so the
    // parsed object cannot show where they actually were; only the raw envelope
    // can, and `tokens` nested vs `access_token` at the top level are both
    // shapes this backend uses on different endpoints.
    //
    // KEYS ONLY, never values: this object carries the access and refresh
    // tokens themselves, and a log is exactly where they must not appear.
    if (raw && typeof raw === "object") {
      const top = Object.keys(raw as Record<string, unknown>);
      const tokens = (raw as { tokens?: unknown }).tokens;
      console.log(
        "[auth] /auth/device response shape:",
        JSON.stringify({
          keys: top,
          tokensType: tokens === undefined ? "absent" : typeof tokens,
          tokenKeys:
            tokens && typeof tokens === "object"
              ? Object.keys(tokens as Record<string, unknown>)
              : undefined,
        }),
      );
    }

    result = stepResponseSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    if (error instanceof UnknownStageError) {
      return { ok: false, error: error.message };
    }
    return {
      ok: false,
      error: signInError(error, "That device could not be verified"),
      restart: isChallengeDead(error),
    };
  }

  // Outside the try — applyStage() redirects by throwing. On a returning login
  // this lands on FACE_REQUIRED; on a first login, on COMPLETED with tokens.
  return applyStage(result);
}

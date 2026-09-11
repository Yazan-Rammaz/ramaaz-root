"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/api/server";
import {
  applyStage,
  clearChallenge,
  readChallenge,
  setLastLink,
  setSignInError,
  UnknownStageError,
} from "@/lib/auth/challenge";
import { openLink } from "@/lib/auth/link";
import { clearAuthCookies } from "@/lib/auth/cookies";
import {
  AUTH_PATHS,
  deviceOptionsResponseSchema,
  ERROR_CODES,
  stepResponseSchema,
  type DeviceRequest,
  type EvidenceRequest,
  type PrivateCodeRequest,
} from "@/lib/auth/endpoints";
import { errorCode, isChallengeDead, signInError } from "@/lib/auth/errors";
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
    //
    // ⚠️ `CHALLENGE_INVALID` ONLY — deliberately NOT `isChallengeDead`, which
    // also counts `UNAUTHENTICATED`.
    //
    // The private code lives 50 seconds (PRIVATE_CODE_TTL), which is shorter
    // than WhatsApp delivery often takes, so "that code is not valid, get a new
    // one" is the NORMAL outcome here rather than an exceptional one. Treating
    // it as a dead challenge tore the input off the screen and left "start
    // over" as the only move — when the right move is to message the number
    // again and type the new code into the same challenge, which is still
    // perfectly alive. The sequence survives a wrong code; it is only
    // CHALLENGE_INVALID that says the sequence itself is gone.
    return {
      ok: false,
      error: signInError(error, "That code is not correct"),
      restart: errorCode(error) === ERROR_CODES.challengeInvalid,
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
export async function submitFaceAction(
  stepToken: string,
  /**
   * The still the check ended on, base64, and the scores that went with it.
   *
   * ⚠️ Read what this is and is NOT before changing it. It is the frame the
   * screen SHOWED — presentational, chosen by the browser, and not the image
   * anything was judged against. AWS judged a video it holds itself, and the
   * Worker fetched the reference from AWS rather than from us; that is the
   * property which makes a tampered client unable to choose who gets compared,
   * and it is worth more than any score.
   *
   * So this travels as a RECORD, never as evidence. The backend stores it so
   * `/login/identity` has a face to show after a refresh — see
   * docs/kyc/step-restore.md — and nothing downstream may treat it as proof.
   */
  record?: {
    faceCapturedPhoto: string | null;
    faceMatchScore?: number;
    livenessConfidence?: number;
  },
): Promise<ActionState> {
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
      evidence: {
        step_token: stepToken,
        // Recorded alongside the proof, not as part of it — see the note on
        // `record` above. Omitted entirely when absent rather than sent as
        // null, so a backend that does not know these fields sees the exact
        // payload it always did.
        ...(record?.faceCapturedPhoto
          ? { faceCapturedPhoto: record.faceCapturedPhoto }
          : {}),
        ...(record?.faceMatchScore !== undefined
          ? { faceMatchScore: record.faceMatchScore }
          : {}),
        ...(record?.livenessConfidence !== undefined
          ? { livenessConfidence: record.livenessConfidence }
          : {}),
      },
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
 * The challenge is gone — stop, and say so.
 *
 * For the failures where retrying is not merely unlikely to work but CANNOT:
 * a 401 from a step route means the challenge behind it has expired, been
 * spent, or burned through its five attempts. The backend will answer the same
 * way every time, so a screen that keeps offering "try again" is inviting
 * somebody to press a button that has already been decided against.
 *
 * Lands on /no-access, which is where a dead sign-in belongs — and because the
 * link token is carried over first, that screen can offer to open the SAME link
 * again, which is the one thing that does work.
 */
export async function expireSignInAction(): Promise<void> {
  const { linkToken } = await readChallenge();

  await clearChallenge();
  if (linkToken) await setLastLink(linkToken);

  await setSignInError(
    "This sign-in expired. Open your access link again to restart.",
  );
  redirect("/no-access");
}

/**
 * Start the sign-in over on a burned challenge.
 *
 * ── What it used to do, and why that could only fail ─────────────────────────
 * `clearChallenge()` then `redirect("/login")`. But /login redirects to
 * /no-access the instant there is no challenge token — so clearing one and then
 * going there is a guaranteed trip to the refusal screen. Every press of a
 * button labelled "Open your access link again" landed on "You don't have
 * access", which is both wrong and the single most alarming thing this app can
 * tell somebody mid-sign-in.
 *
 * ── What it does now ─────────────────────────────────────────────────────────
 * Actually re-opens the link. The access-link token is the only thing that can
 * mint a new challenge, and `ChallengeState.linkToken` is holding it, so this
 * spends it exactly as the original tap did.
 *
 * The clear happens FIRST and is load-bearing: `openLink` short-circuits when it
 * finds a live challenge for the same token, and a challenge burned by failed
 * attempts is not expired by the clock — so leaving it would resume the dead
 * sequence and the button would appear to do nothing at all.
 *
 * The token never goes near a URL here. /enter/<token> would have worked too,
 * but a redirect puts it in history a second time for no gain when the server
 * can simply spend it in place.
 */
export async function restartSignInAction(): Promise<void> {
  const { linkToken } = await readChallenge();

  await clearChallenge();

  // Nothing to re-open — an older cookie from before the token was stored, or a
  // challenge that never came from a link at all. There is genuinely no way
  // forward from here but a fresh link, so say so rather than loop.
  if (!linkToken) redirect("/no-access");

  // Redirects on success, exactly as the first open did.
  const { error } = await openLink(linkToken);
  await setSignInError(error);
  // So /no-access can offer this same link again — see setLastLink.
  await setLastLink(linkToken);
  redirect("/no-access");
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

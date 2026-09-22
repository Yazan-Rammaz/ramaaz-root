"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/api/server";
import {
  applyStage,
  clearChallenge,
  readChallenge,
  readLastLink,
  setLastLink,
  setSignInError,
  UnknownStageError,
} from "@/lib/auth/challenge";
import { openLink } from "@/lib/auth/link";
import { clearAuthCookies } from "@/lib/auth/cookies";
import {
  AUTH_PATHS,
  deviceOptionsResponseSchema,
  stepResponseSchema,
  type DeviceRequest,
  type EvidenceRequest,
  type PrivateCodeRequest,
} from "@/lib/auth/endpoints";
import {
  isChallengeDead,
  signInError,
  signInDiag,
  type SignInDiag,
} from "@/lib/auth/errors";
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
  /**
   * The private code was consumed by this attempt — wrong, expired or already
   * used, which the server deliberately does not distinguish.
   *
   * Only `submitPrivateCodeAction` sets it. There is ONE attempt per code, so a
   * refusal leaves nothing to retype: the way forward is a new code, which only
   * the administrator can pull by messaging the number again. The screen uses
   * this to lead with that instruction instead of sitting on a field whose
   * contents can no longer work.
   */
  codeSpent?: boolean;
  /**
   * What the backend ACTUALLY said — status, error code, correlation id — as
   * distinct from `error`, which is the sentence for the screen.
   *
   * Carried because a Server Action always answers HTTP 200: the RSC protocol
   * puts the outcome in the body, so a refusal reaches the browser looking like
   * a successful request and the diagnostics record a clean session. The client
   * passes this to `reportUserError`, which is the only reason a rejected
   * sign-in is visible in the logs at all.
   *
   * Never rendered. It is for the log, and it names the backend's own wording,
   * which is usually more specific than ours.
   */
  diag?: SignInDiag;
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
    // A wrong code alerts the other root administrators — somebody holding a
    // link and guessing is the shape of a forwarded link — and it SPENDS the
    // code: one attempt per code, no second guess. But the challenge survives
    // it. Only CHALLENGE_INVALID says the sequence itself is gone, and
    // `isChallengeDead` is now exactly that test.
    //
    // The code's life is short — shorter than WhatsApp delivery often takes —
    // so "that code is not valid, get a new one" is the NORMAL outcome here
    // rather than an exceptional one. Treating it as a dead challenge tore the
    // input off the screen and left "start over" as the only move, when the
    // right move is to message the number again and type the new code into the
    // same, perfectly alive, challenge.
    return {
      ok: false,
      error: signInError(error, "That code is not correct"),
      diag: signInDiag(error),
      restart: isChallengeDead(error),
      // The code is spent whatever happened to it — wrong, expired or already
      // used all answer the same. So the screen's next move is "message the
      // number again", not "type it again".
      codeSpent: !isChallengeDead(error),
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
 * because every failure is charged against the challenge and the backend kills
 * it when the budget is gone. The frontend deliberately keeps no attempt
 * counter of its own: two authorities disagreeing about how many tries remain
 * is worse than one.
 *
 * ⚠️ Never call this without a step token. The backend answers 401 and charges
 * a SECOND attempt on top of the one the failure already cost — which is what
 * the guard below is for.
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
      diag: signInDiag(error),
      restart: isChallengeDead(error),
    };
  }

  // Outside the try — applyStage() redirects by throwing.
  return applyStage(result);
}

/**
 * The evidence the document step takes. The only shape it takes.
 *
 * Identical to the face step, and for the same reason: the images go to the KYC
 * Worker, the Worker commits what it measured over its own signed channel,
 * `POST /v1/kyc/submit` decides and mints a single-use token, and only that
 * token is posted here. No biometric and no government document touches the
 * auth path.
 *
 * ⚠️ The base64 payload that used to live beside this is GONE — posting
 * `{ document_type, front, back }` now answers 422. `/v1/kyc/submit` is live, so
 * there is no interim to keep.
 */
export type DocumentStepTokenEvidence = { step_token: string };

/**
 * Stage 4 — first-login ID enrolment, and now the LAST step of the whole
 * sign-in.
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
 * ── One shape, and the migration is done ────────────────────────────────────
 * It posts `{ step_token }`, exactly like `/auth/face`. The base64 interim is
 * gone: `/v1/kyc/submit` is live and mints the proof, and the old payload now
 * answers 422.
 *
 * Three document tries per sign-in, and a failure charges the sign-in's counter
 * too. A failed verdict never reaches here — no step token is minted, so
 * `IdentityStep` shows the failure and the person re-captures.
 *
 * ── Where this now ends ─────────────────────────────────────────────────────
 * The response is COMPLETED and carries the token pair, so `applyStage` stores
 * them and the administrator is in. It used to advance to DEVICE_REQUIRED and
 * hand off to the passkey ceremony; device verification is off
 * (`ROOT_REQUIRE_DEVICE=false` — see endpoints.ts), so that stage never comes.
 *
 * Nothing here had to change for that, and that is the point: this function
 * forwards whatever it is handed and `applyStage` obeys whatever comes back. If
 * the setting is flipped, the passkey step reappears with no edit.
 */
export async function submitIdentityDocumentAction(
  evidence: DocumentStepTokenEvidence,
): Promise<ActionState> {
  // An empty proof fails here rather than spending an attempt against the
  // challenge — and it would spend TWO, since calling this without a step token
  // is itself charged on top of whatever failure lost the token.
  //
  // A SHAPE guard, not an attempt counter: nothing in this app keeps a failure
  // count or decides a retry is not allowed. The backend owns that and says so
  // on every response — see rule 3 in lib/auth/endpoints.ts.
  if (!evidence.step_token) return { ok: false, error: "No document evidence" };

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
      diag: signInDiag(error),
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
 * spent, or burned through whatever failure budget the backend holds for it.
 * The backend will answer the same way every time, so a screen that keeps
 * offering "try again" is inviting somebody to press a button that has already
 * been decided against.
 *
 * Note what decides that: the BACKEND'S answer, not a count kept here. We never
 * predict the ceiling, we only obey the refusal when it arrives.
 *
 * Lands on /no-access, which is where a dead sign-in belongs — and because the
 * link token is carried over first, that screen can offer to open the SAME link
 * again, which is the one thing that does work.
 */
export async function expireSignInAction(): Promise<void> {
  // ⚠️ TWO sources, and the second is the one that usually has it.
  //
  // The challenge cookie is the obvious place — and it is gone in exactly the
  // situation this function exists for. A challenge that expired took its own
  // cookie with it, so reading only there meant "start over" worked whenever it
  // was not needed and failed whenever it was.
  //
  // `root_last_link` is written the moment a link is opened and outlives the
  // challenge by a day, for this.
  const { linkToken } = await readChallenge();
  const token = linkToken ?? (await readLastLink());

  await clearChallenge();
  if (token) await setLastLink(token);

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
  // ⚠️ TWO sources, and the second is the one that usually has it.
  //
  // The challenge cookie is the obvious place — and it is gone in exactly the
  // situation this function exists for. A challenge that expired took its own
  // cookie with it, so reading only there meant "start over" worked whenever it
  // was not needed and failed whenever it was.
  //
  // `root_last_link` is written the moment a link is opened and outlives the
  // challenge by a day, for this.
  const { linkToken } = await readChallenge();
  const token = linkToken ?? (await readLastLink());

  await clearChallenge();

  // Nothing to re-open — an older cookie from before the token was stored, or a
  // challenge that never came from a link at all. There is genuinely no way
  // forward from here but a fresh link, so say so rather than loop.
  if (!token) redirect("/no-access");

  // Redirects on success, exactly as the first open did.
  const { error } = await openLink(token);
  await setSignInError(error);
  // So /no-access can offer this same link again — see setLastLink. Written
  // from `token`, not `linkToken`: after a challenge has expired the only copy
  // left is the long-lived one, and re-writing that is what keeps the day-long
  // window rolling for somebody who comes back to try again.
  await setLastLink(token);
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
      diag: signInDiag(error),
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
      diag: signInDiag(error),
      restart: isChallengeDead(error),
    };
  }

  // Outside the try — applyStage() redirects by throwing. On a returning login
  // this lands on FACE_REQUIRED; on a first login, on COMPLETED with tokens.
  return applyStage(result);
}

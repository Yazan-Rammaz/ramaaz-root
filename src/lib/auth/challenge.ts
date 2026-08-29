import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isProd } from "@/lib/env";
import {
  CHALLENGE_MAX_AGE,
  REFRESH_MAX_AGE,
  STAGES,
  STAGE_ROUTES,
  type StepResponse,
} from "@/lib/auth/endpoints";
import { setAuthCookies } from "@/lib/auth/cookies";

/**
 * The sign-in challenge — the whole client side of the auth state machine.
 *
 * ── What lives here and why ─────────────────────────────────────────────────
 * Between steps the flow is nothing but a rotating token and a stage name.
 * Both ride in ONE httpOnly cookie, so no part of a half-finished sign-in ever
 * reaches client JS, and the browser cannot skip a step by editing state.
 *
 * The previous design gave each step its OWN token (`setupToken`,
 * `unlockToken`) and proved progress by which token you held. This one keeps a
 * single `challengeToken` and names the position separately — which is what
 * lets `applyStage` route on the server's answer instead of on a step counter.
 */
const COOKIE = "root_challenge";

export type ChallengeState = {
  /**
   * The server's own position — "PRIVATE_CODE_REQUIRED", "FACE_REQUIRED", …
   * The screens gate on this, so a step reached by typing its URL directly
   * bounces back to wherever the server actually is.
   */
  stage?: string;
  /**
   * The credential for every step. One value for the whole attempt — it does
   * not rotate — but it is still stored from the RESPONSE rather than kept
   * from what we sent, so a server that starts reissuing it needs no change
   * here.
   */
  challengeToken?: string;
  /**
   * Correlation id for this attempt. Stable, and not a credential.
   *
   * The KYC Worker needs something it can put in a request body and a log line
   * to identify whose sign-in it is holding, and the token cannot do that job.
   * Without this the face check fails at the Worker with
   * `422 challengeId is required`, before the backend is ever contacted.
   */
  challengeId?: string;
  /**
   * When the whole sequence dies (10 min from /auth/link). ISO string, drives
   * the countdown. Authoritative — do not compute a deadline locally.
   */
  challengeExpiresAt?: string;
};

export async function readChallenge(): Promise<ChallengeState> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ChallengeState;
  } catch {
    return {};
  }
}

/** Server Actions and Route Handlers only — a render may not set cookies. */
export async function writeChallenge(state: ChallengeState) {
  (await cookies()).set(COOKIE, JSON.stringify(state), {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: CHALLENGE_MAX_AGE,
  });
}

export async function clearChallenge() {
  (await cookies()).delete(COOKIE);
}

/**
 * Raised when the server reports a stage no screen answers.
 *
 * Its own error type because the honest response is different from every other
 * failure: nothing the administrator can do fixes it, and retrying cannot
 * help. It means this frontend is older than the backend — a new check was
 * switched on that we have no screen for.
 */
export class UnknownStageError extends Error {
  constructor(readonly stage: string) {
    super(`This sign-in needs a step this app does not support yet (${stage})`);
    this.name = "UnknownStageError";
  }
}

/**
 * THE router. Every step handler ends here, and none of them names its own
 * successor.
 *
 * That is the point: the server decides what is still owed, so a check
 * switched off in a deployment simply never reports its stage and this walks
 * straight past it. A client that hard-coded "password then OTP then PIN" is
 * exactly what broke when the protocol changed underneath it.
 *
 * ⚠️ CALL THIS OUTSIDE YOUR try/catch. `redirect()` signals by throwing, so a
 * call inside a try block is caught by your own error handler and the
 * navigation is swallowed — the screen just sits there looking successful.
 *
 * @returns never — it always either redirects or throws.
 */
export async function applyStage(result: StepResponse): Promise<never> {
  // The end of the flow: this is the only response that carries tokens.
  if (result.stage === STAGES.completed) {
    if (!result.tokens) {
      throw new Error("The server reported COMPLETED without issuing tokens");
    }
    const { access_token, refresh_token, expires_in } = result.tokens;
    await setAuthCookies({
      accessToken: access_token,
      refreshToken: refresh_token,
      accessMaxAge: expires_in,
      // The refresh token never expires; only the cookie ceiling applies.
      refreshMaxAge: REFRESH_MAX_AGE,
    });
    await clearChallenge();
    redirect("/dashboard");
  }

  const next = STAGE_ROUTES[result.stage];
  if (!next) throw new UnknownStageError(result.stage);

  // Every step but the last re-issues the token; a response without one would
  // leave the next call unable to prove anything, so fail here rather than
  // sending an empty token and reading CHALLENGE_INVALID as the user's fault.
  if (!result.challenge_token) {
    throw new Error(`Stage ${result.stage} arrived without a challenge token`);
  }

  // Carried forward when a response omits it: the id is stable for the whole
  // attempt, so a step that does not echo it has not changed it.
  const current = await readChallenge();

  await writeChallenge({
    stage: result.stage,
    challengeToken: result.challenge_token,
    challengeId: result.challenge_id ?? current.challengeId,
    challengeExpiresAt: result.challenge_expires_at,
  });

  redirect(next);
}

/**
 * Guard for a step screen: the live challenge, or back to the start.
 *
 * Two things are checked, because they fail differently. No token at all means
 * there is no sign-in in progress. A token at the WRONG stage means the URL
 * was typed or the back button was used — the server would answer
 * CHALLENGE_INVALID and burn the challenge, so bounce to where it actually is
 * instead of spending an attempt to discover that.
 */
export async function requireStage(stage: string): Promise<ChallengeState> {
  const challenge = await readChallenge();
  if (!challenge.challengeToken) redirect("/login");
  if (challenge.stage !== stage) {
    redirect(STAGE_ROUTES[challenge.stage ?? ""] ?? "/login");
  }
  return challenge;
}

/* ─────────────────────── the failure flash ─────────────────────── */

/**
 * One-shot cookie carrying why a sign-in attempt was refused.
 *
 * It exists because the failure happens in a Route Handler (`/enter/[token]`)
 * and has to be shown by a page. Passing it in the query string would work but
 * would then sit in history and be re-shown on every back-navigation to a URL
 * that no longer describes reality.
 *
 * Deliberately NOT cleared on read: a Server Component render may not mutate
 * cookies. The short max-age is what retires it instead, which is also why the
 * message must be safe to show slightly late — it never names a cause the
 * server did not name.
 */
const ERROR_COOKIE = "root_signin_error";
const ERROR_MAX_AGE = 30;

export async function setSignInError(message: string) {
  (await cookies()).set(ERROR_COOKIE, message, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: ERROR_MAX_AGE,
  });
}

export async function readSignInError(): Promise<string | null> {
  return (await cookies()).get(ERROR_COOKIE)?.value ?? null;
}

/**
 * A label for the SESSION this sign-in opens — not for the passkey, which is
 * labelled separately at /auth/device.
 *
 * Derived from the User-Agent because the administrator has nowhere to type
 * one at this point in the flow: /auth/link is the very first call and no
 * screen has been shown yet. A rough "Chrome on Windows" is far more use in a
 * session list than a blank, and it never blocks the sign-in — an unparseable
 * agent just yields "Browser".
 */
export async function sessionLabel(): Promise<string> {
  const ua = (await headers()).get("user-agent") ?? "";

  const browser =
    /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bSafari\//.test(ua) ? "Safari"
    : "Browser";

  const os =
    /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : null;

  return os ? `${browser} on ${os}` : browser;
}

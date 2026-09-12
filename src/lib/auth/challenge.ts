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
import { setAuthCookies, setSessionUser } from "@/lib/auth/cookies";

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
  /**
   * The access-link token that opened this challenge. Two jobs:
   *
   *  1. It makes `/enter/<token>` IDEMPOTENT — `openLink` compares the incoming
   *     token against this one and resumes instead of re-opening.
   *  2. It is the ONLY thing that can open a new challenge, which is what
   *     `restartSignInAction` needs to actually restart anything.
   *
   * ── Why the token and not a hash of it ──────────────────────────────────────
   * This held a SHA-256 first, on the reasoning that the link token is reusable
   * for the life of the link while the challenge token beside it dies in ten
   * minutes — so it is the more valuable of the two and the one worth not
   * keeping. That reasoning was sound for job 1, which only ever asks "is this
   * the same link?", and a hash answers that perfectly.
   *
   * It cannot do job 2. A hash is one-way, so "start over" had nothing to
   * re-open and could only clear the challenge and bounce to /login — which
   * redirects to /no-access the moment there is no challenge, making that button
   * a guaranteed dead end.
   *
   * So the token is stored. The exposure is real but small and bounded: the
   * cookie is httpOnly, Secure in production, SameSite=lax, and expires with the
   * challenge at CHALLENGE_MAX_AGE (10 minutes). The same browser already holds
   * this token in its history, and the message it came from is still sitting in
   * WhatsApp. Nothing reads it back out to the client — `restartSignInAction`
   * spends it server-side and never puts it in a URL.
   */
  linkToken?: string;
  /**
   * Where the face captured earlier in THIS sign-in is stored.
   *
   * A URL, so it fits here — the image is ~300KB and a cookie holds 4KB. It is
   * what makes a refresh on the ID step keep the face: the captured frame is
   * React state and does not survive a reload, and nobody should be asked to
   * photograph themselves twice for one sign-in.
   *
   * Never handed to the browser as-is. `/api/face-capture` reads it here and
   * fetches server-side, so the URL stays on this side of the BFF.
   */
  faceCaptureUrl?: string;
};

/**
 * Is this challenge still inside its own deadline?
 *
 * `challenge_expires_at` is the server's, and authoritative. An absent or
 * unparseable value is treated as LIVE deliberately: the cookie's own
 * `CHALLENGE_MAX_AGE` already retires it at ten minutes, and guessing "dead"
 * here would throw away a working sign-in over a date format.
 */
export function challengeIsLive(state: ChallengeState): boolean {
  if (!state.challengeToken) return false;
  if (!state.challengeExpiresAt) return true;
  const deadline = Date.parse(state.challengeExpiresAt);
  return Number.isNaN(deadline) || deadline > Date.now();
}

export async function readChallenge(): Promise<ChallengeState> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ChallengeState;
  } catch {
    return {};
  }
}

/**
 * How long the cookie should live — taken from the SERVER'S deadline.
 *
 * ⚠️ There must be ONE clock, and it is the backend's.
 *
 * This used to be `CHALLENGE_MAX_AGE`, a local constant, while
 * `challenge_expires_at` sat unused three fields away under a comment calling
 * it "authoritative — do not compute a deadline locally". So there were two
 * deadlines, started at different moments: the backend's runs from /auth/link
 * and is never refreshed, ours restarted on every step that wrote the cookie.
 *
 * When ours expired first the browser simply had no credential, the KYC proxy
 * sent none, and the Worker answered a bare 401 — which the enrolment screen
 * reported as "ID Matching With Your Photo Not Correct". A stopwatch nobody
 * knew about, blamed on somebody's face.
 *
 * The GRACE is deliberate and is the point of the whole change. The cookie now
 * outlives the challenge by a minute so that when time does run out, the
 * request still goes out, the BACKEND refuses it, and the user is told what
 * happened. Expiring first only ever produced silence.
 *
 * Falls back to the constant when the server sent no deadline, which is the
 * only case where guessing is better than nothing.
 */
const EXPIRY_GRACE_SECONDS = 60;

function cookieLifetime(state: ChallengeState): number {
  if (!state.challengeExpiresAt) return CHALLENGE_MAX_AGE;

  const deadline = Date.parse(state.challengeExpiresAt);
  if (Number.isNaN(deadline)) return CHALLENGE_MAX_AGE;

  const seconds =
    Math.ceil((deadline - Date.now()) / 1000) + EXPIRY_GRACE_SECONDS;

  // Never zero or negative: that deletes the cookie outright, and a dead
  // challenge should still reach the backend to be refused out loud.
  return Math.max(seconds, EXPIRY_GRACE_SECONDS);
}

/** Server Actions and Route Handlers only — a render may not set cookies. */
export async function writeChallenge(state: ChallengeState) {
  (await cookies()).set(COOKIE, JSON.stringify(state), {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: cookieLifetime(state),
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
export async function applyStage(
  result: StepResponse,
  /**
   * Only `openLink` passes this — it is the one caller that knows which access
   * link is in play. Every later step omits it and the stored value is carried
   * forward, exactly as `challengeId` is.
   */
  linkToken?: string,
): Promise<never> {
  // The end of the flow: this is the only response that carries tokens.
  if (result.stage === STAGES.completed) {
    if (!result.tokens) {
      throw new Error("The server reported COMPLETED without issuing tokens");
    }
    const { access_token, refresh_token, expires_in, user } = result.tokens;
    await setAuthCookies({
      accessToken: access_token,
      refreshToken: refresh_token,
      accessMaxAge: expires_in,
      // The refresh token never expires; only the cookie ceiling applies.
      refreshMaxAge: REFRESH_MAX_AGE,
    });
    // ⚠️ The ONLY moment the signed-in user is known.
    //
    // `GET /v1/me` does not work, so nothing can ask again later. This response
    // carries the full user and it is the last chance to keep it — miss it and
    // every protected page decides nobody is signed in. See the USER cookie.
    await setSessionUser(user, REFRESH_MAX_AGE);
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
    // Carried forward for the same reason as challengeId, and it MUST be: drop
    // it at the first step and `/enter/<token>` stops being idempotent — and
    // "start over" stops working — the moment the administrator types their
    // private code, which is precisely when they most need both.
    linkToken: linkToken ?? current.linkToken,
    // Carried forward like challengeId: the backend sends it on the response
    // that first knows about it, and every later step would otherwise drop it.
    faceCaptureUrl: result.face_capture_url ?? current.faceCaptureUrl,
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
 * The link token of the attempt that just failed, so /no-access can offer the
 * one thing that could help: opening it again.
 *
 * Separate from the challenge cookie because the two do not survive together —
 * by the time anyone sees /no-access the challenge is usually gone, which is
 * precisely WHY they are seeing it. This outlives it by a few seconds, long
 * enough to render one link.
 *
 * Written only where the token is actually known (the `/enter` handler and
 * `restartSignInAction`). Everywhere else /no-access shows no link at all,
 * which is correct: a browser that never held a link has nothing to re-open,
 * and a "try again" that cannot work is worse than silence.
 */
const LAST_LINK_COOKIE = "root_last_link";

/**
 * ⚠️ DELIBERATELY MUCH LONGER THAN THE CHALLENGE. Do not tie this to it again.
 *
 * This has been wrong twice, the same way both times, and the mistake is worth
 * naming because it is easy to repeat: the lifetime of a RECOVERY was tied to
 * the lifetime of the thing it recovers FROM.
 *
 *   first  ERROR_MAX_AGE, 30 seconds — gone before anything could go wrong.
 *   then   CHALLENGE_MAX_AGE + 60, eleven minutes — gone at exactly the moment
 *          it was needed, because the case that needs it IS a session that ran
 *          past ten minutes. An administrator whose enrolment overran reached
 *          /no-access and was offered nothing, having arrived by a link the
 *          browser had simply forgotten.
 *
 * The link token does not expire with the challenge. It is valid for the life
 * of the LINK — the backend decides that, and it outlasts any one attempt by a
 * long way. Re-opening it is the correct recovery from every failure in this
 * flow, so the only question is how long somebody might plausibly come back,
 * and the answer is "later today".
 *
 * The exposure is a link token in an httpOnly, Secure, SameSite=lax cookie —
 * on a device that already holds the same token in its history, from a message
 * still sitting in WhatsApp. It is never read back out to the client.
 */
const LAST_LINK_MAX_AGE = 60 * 60 * 24;

export async function setLastLink(token: string) {
  (await cookies()).set(LAST_LINK_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: LAST_LINK_MAX_AGE,
  });
}

export async function readLastLink(): Promise<string | null> {
  return (await cookies()).get(LAST_LINK_COOKIE)?.value ?? null;
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

import "server-only";
import { ApiError, BackendNotConfiguredError } from "@/lib/api/server";
import { apiErrorSchema, ERROR_CODES } from "@/lib/auth/endpoints";

/**
 * Turning a backend failure into something a person can act on.
 *
 * One place, because the sign-in steps all fail the same way and the protocol
 * is opinionated about what may be said. In particular: refusals from
 * /auth/link are DELIBERATELY indistinguishable from one another — unknown
 * link, revoked, expired, wrong address range, wrong country, suspended
 * account all answer UNAUTHENTICATED — so the screen must not speculate about
 * which one tripped.
 */

/** The backend's machine-readable error code, when there is one. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const parsed = apiErrorSchema.safeParse(error.body);
  return parsed.success ? parsed.data.error.code : undefined;
}

/**
 * The `correlation_id` the backend attaches to every error. Support needs it to
 * trace a failed sign-in, and it is the only handle on a failure the admin
 * cannot otherwise describe.
 */
export function correlationId(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const parsed = apiErrorSchema.safeParse(error.body);
  return parsed.success ? parsed.data.error.correlation_id : undefined;
}

/**
 * How long the backend wants us to wait, in seconds, on a 429.
 *
 * Two sources for one number, and they are the same number: the `Retry-After`
 * header (captured onto the error in `lib/api/server.ts`, because the response
 * itself does not survive that function) and `error.details.retry_after_seconds`
 * in the body. The header wins — a 429 raised by an edge or a proxy in front of
 * the backend carries it with no JSON body at all.
 *
 * Undefined when neither is present. Callers pick their own default; they must
 * NOT treat "no number" as "retry immediately".
 */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds;

  const parsed = apiErrorSchema.safeParse(error.body);
  return parsed.success
    ? parsed.data.error.details?.retry_after_seconds
    : undefined;
}

/**
 * True when the challenge itself is dead — expired, already used, or burned
 * through its attempts.
 *
 * Retrying the step CANNOT succeed; only starting over can. Callers use this to
 * send the admin back to their link instead of letting them press a button that
 * has already been decided against.
 *
 * ── `CHALLENGE_INVALID` and nothing else ────────────────────────────────────
 * This used to count `UNAUTHENTICATED` too, and that was wrong in the common
 * case. On a step route it means "no proof outstanding" — the Worker's commit
 * never passed, the token was for another sign-in, or it expired. **The
 * challenge is still alive**; it merely cost an attempt, and the right move is
 * to re-capture. Treating it as dead threw away a live sequence and spent one of
 * the ten link-opens a minute to rebuild what was already there.
 *
 * ⚠️ Read the CODE, never the status. Distinct 401s exist and most do not mean
 * "this sign-in is over": `MFA_REQUIRED` means "prove yourself and retry",
 * `TOKEN_EXPIRED` means "refresh", `UNAUTHENTICATED` means four different things
 * depending on which call returned it (see ERROR_CODES). Widening this to
 * `error.status === 401` turns all of them into a sign-out.
 */
export function isChallengeDead(error: unknown): boolean {
  return errorCode(error) === ERROR_CODES.challengeInvalid;
}

/**
 * What REALLY came back, for the log — as distinct from what goes on screen.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A Server Action answers the browser with HTTP 200 whatever happened inside
 * it: the RSC protocol carries the outcome in the body, not the status. So a
 * sign-in that the backend refused with 401 and a real reason arrives at the
 * collector looking like a perfectly successful request, and the only trace of
 * the refusal is a sentence rendered on a screen nobody is watching.
 *
 * That is not hypothetical — a private code was rejected with "That code is
 * not valid. Message the system to get a new one." and the diagnostics showed
 * nothing at all, because `signInError` had already flattened an ApiError into
 * a display string and thrown the status, the code and the correlation id away.
 *
 * Returned alongside the message so the client can report both: the sentence
 * the person read, and the answer the backend actually gave.
 */
export type SignInDiag = {
  status?: number;
  code?: string;
  correlationId?: string;
  /** The backend's own wording, which is often more specific than ours. */
  backendMessage?: string;
};

export function signInDiag(error: unknown): SignInDiag {
  if (!(error instanceof ApiError)) {
    return { backendMessage: error instanceof Error ? error.message : undefined };
  }
  return {
    status: error.status,
    code: errorCode(error),
    correlationId: correlationId(error),
    backendMessage: error.message,
  };
}

/** What to put on the screen. `fallback` covers non-API failures. */
export function signInError(error: unknown, fallback: string): string {
  if (error instanceof BackendNotConfiguredError) {
    return "Sign-in is not connected to a backend yet";
  }
  if (!(error instanceof ApiError)) return fallback;

  // ⚠️ The code is read BEFORE anything keyed on the status, and that order is
  // load-bearing — see the note on isChallengeDead above.
  switch (errorCode(error)) {
    case ERROR_CODES.challengeInvalid:
      return "This sign-in expired. Open your access link again to restart.";
    case ERROR_CODES.rateLimited:
      return rateLimitMessage(error);
    case ERROR_CODES.serviceUnavailable:
      // Say the SERVICE is down. Never imply the code was wrong: it may have
      // been perfect and simply never delivered.
      return "The verification service is unavailable. Please try again.";
    case ERROR_CODES.mfaRequired:
      // Not reachable today (no session holds a passkey while device
      // verification is off), and we have deliberately not built the ceremony.
      // Here so it lands as its own sentence rather than falling through to a
      // generic 401 path that would sign the administrator out.
      return "This action needs an extra security check that is not available yet.";
    case ERROR_CODES.preconditionFailed:
      // The backend's own wording is the specific one here — it distinguishes
      // "you skipped a step" from "this session can never do that".
      return error.message || "That step cannot be completed right now.";
    default:
      break;
  }

  // A 429 with no recognised code — an edge or a proxy in front of the backend
  // rather than the backend itself.
  if (error.status === 429) return rateLimitMessage(error);

  return error.message || fallback;
}

/**
 * The wait notice for a 429 — with the real number when the backend gave one.
 *
 * NEVER paired with an automatic retry anywhere. The limit is keyed on the
 * caller's address, and the caller is this Worker, so a retry loop spends a
 * budget shared with every other administrator signing in at that moment. The
 * person decides when to try again.
 */
function rateLimitMessage(error: unknown): string {
  const seconds = retryAfterSeconds(error);
  return seconds
    ? `Too many requests. Please wait ${seconds} seconds and try again.`
    : "Too many requests. Wait a minute before trying again.";
}

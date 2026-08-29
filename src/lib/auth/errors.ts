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
 * True when the challenge itself is dead — expired, already used, burned by
 * too many failed attempts, or a step sent out of order.
 *
 * Retrying the step CANNOT succeed; only starting over can. Callers use this
 * to send the admin back to the link instead of letting them type a second
 * code into a challenge that no longer exists.
 */
export function isChallengeDead(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === ERROR_CODES.challengeInvalid || code === ERROR_CODES.unauthenticated
  );
}

/** What to put on the screen. `fallback` covers non-API failures. */
export function signInError(error: unknown, fallback: string): string {
  if (error instanceof BackendNotConfiguredError) {
    return "Sign-in is not connected to a backend yet";
  }
  if (!(error instanceof ApiError)) return fallback;

  switch (errorCode(error)) {
    case ERROR_CODES.challengeInvalid:
      return "This sign-in expired. Open your access link again to restart.";
    case ERROR_CODES.rateLimited:
      // Five private-code requests per fifteen minutes, per number. Never
      // auto-retry — that is what tripped it.
      return "Too many requests. Wait a few minutes before trying again.";
    case ERROR_CODES.serviceUnavailable:
      // Say the SERVICE is down. Never imply the code was wrong: it may have
      // been perfect and simply never delivered.
      return "The verification service is unavailable. Please try again.";
    default:
      break;
  }

  if (error.status === 429) {
    return "Too many attempts — please wait a minute and try again";
  }
  return error.message || fallback;
}

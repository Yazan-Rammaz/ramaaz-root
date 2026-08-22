import "server-only";
import { cookies } from "next/headers";

/**
 * The invitation `token` sent alongside the credentials in POST /v1/registration.
 *
 * ── Where it comes from ─────────────────────────────────────────────────────
 * Two sources, in order:
 *
 *   1. The `rdb_dev_token` cookie, set by /api/dev/reset when the temporary
 *      autofill mints a fresh admin. Always the newest token.
 *   2. `REGISTRATION_TOKEN` in .env.local, refreshed by `npm run dev:reset`.
 *
 * It is NOT fetched on demand, deliberately. The only endpoint that issues one
 * — POST /v1/dev/reset-root — DELETES the current root admin and mints a
 * replacement. Calling that from here would wipe the administrator on every
 * sign-in attempt.
 *
 * The token is SINGLE USE: one registration attempt spends it, and every reset
 * invalidates the token before it.
 *
 * Deliberately `async`: when a real issuing endpoint arrives this becomes a
 * fetch, and no call site has to change.
 */

/** Raised when no token is available — the request would be rejected anyway. */
export class RegistrationTokenUnavailableError extends Error {
  constructor() {
    super(
      "No registration token — set REGISTRATION_TOKEN, or wire the token endpoint",
    );
    this.name = "RegistrationTokenUnavailableError";
  }
}

/**
 * Cookie carrying the invitation token minted by the dev reset route.
 *
 * ── Why a cookie and not module state ───────────────────────────────────────
 * A reset issues a NEW invitation token and spends whatever `REGISTRATION_TOKEN`
 * held, so the fresh one has to reach the Server Action that signs in. Stashing
 * it in a module-level variable does NOT work: Route Handlers and Server Actions
 * are separate entry points and do not reliably share module instances, so the
 * action read its own copy, found nothing, fell back to the spent env value and
 * failed with "That invitation link is not valid".
 *
 * A cookie is shared by construction, and it is also the more correct model:
 * the token belongs to the browser session that minted it, not to the server
 * process.
 *
 * httpOnly — the browser never needs to read it.
 */
export const DEV_TOKEN_COOKIE = "rdb_dev_token";

export async function getRegistrationToken(): Promise<string> {
  const fromCookie = (await cookies()).get(DEV_TOKEN_COOKIE)?.value;
  const token = fromCookie || process.env.REGISTRATION_TOKEN;
  if (!token) throw new RegistrationTokenUnavailableError();
  return token;
}

/**
 * Identifies the device a login is bound to. Constant for now — the backend
 * accepts a free-form label and "setup" is what the API contract shows.
 */
export const DEVICE_LABEL = "setup";

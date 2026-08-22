"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { api, ApiError, BackendNotConfiguredError } from "@/lib/api/server";
import {
  setAuthCookies,
  clearAuthCookies,
  setPrivateCodeCookie,
  getPrivateCode,
} from "@/lib/auth/cookies";
import {
  readLoginFlow,
  updateLoginFlow,
  clearLoginFlow,
} from "@/lib/auth/login-flow";
import {
  apiErrorSchema,
  AUTH_PATHS,
  ERROR_CODES,
  loginResponseSchema,
  otpVerifyResponseSchema,
  passCodeResponseSchema,
  registrationResponseSchema,
  REFRESH_MAX_AGE,
  STAGE_COMPLETED,
  STAGE_OTP_REQUIRED,
  STAGE_PASS_CODE_REQUIRED,
  type LoginRequest,
  type OtpVerifyRequest,
  type RegistrationRequest,
} from "@/lib/auth/endpoints";
import {
  DEVICE_LABEL,
  getRegistrationToken,
  RegistrationTokenUnavailableError,
} from "@/lib/auth/registration-token";
import {
  otpSchema,
  passcodeSchema,
  passwordSchema,
  privateCodeSchema,
} from "./schema";

/**
 * Server Actions are THE one way the browser triggers a mutation. The login
 * flow is a chain of steps; each action validates its input, exchanges the
 * previous step's token with the backend, and stores the next step's token in
 * the httpOnly flow cookie. No token ever touches client JS.
 *
 * Paths and response shapes live in `lib/auth/endpoints.ts` — the local backend
 * these were written against is gone, so that table is the one place to remap
 * when the remote backend's contract arrives.
 */
export type ActionState = {
  ok: boolean;
  error?: string;
};

/** The backend's machine-readable error code, when there is one. */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const parsed = apiErrorSchema.safeParse(error.body);
  return parsed.success ? parsed.data.error.code : undefined;
}

function message(error: unknown, fallback: string): string {
  // No backend wired yet — say so, instead of blaming the user's credentials.
  if (error instanceof BackendNotConfiguredError) {
    return "Sign-in is not connected to a backend yet";
  }
  if (!(error instanceof ApiError)) return fallback;
  // Credential endpoints are throttled 5/min per IP; surface that as guidance
  // instead of the backend's raw "ThrottlerException: Too Many Requests".
  if (error.status === 429) {
    return "Too many attempts — please wait a minute and try again";
  }
  return error.message;
}

/**
 * Step 1 — private code.
 *
 * Makes NO backend call: `/v1/registration` needs the code and the password
 * together, and no endpoint validates the code on its own. So this step only
 * checks the format and carries the code forward in the httpOnly flow cookie.
 *
 * Consequence worth knowing: a wrong private code is not reported here — it
 * surfaces on the password screen, because that is where it first reaches the
 * backend.
 */
export async function identifyAction(code: string): Promise<ActionState> {
  const parsed = privateCodeSchema.safeParse({ code });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  await updateLoginFlow({ privateCode: parsed.data.code });

  redirect("/login/password");
}

/**
 * Step 2 — password. Sends code + password + the pre-issued token to
 * `/v1/registration`; the backend fires the WhatsApp OTP and returns the
 * challenge plus everything the verify screen needs to describe it.
 */
export async function passwordAction(password: string): Promise<ActionState> {
  const parsed = passwordSchema.safeParse({ password });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  const flow = await readLoginFlow();
  if (!flow.privateCode) redirect("/login");

  try {
    const token = await getRegistrationToken();

    const raw = await api.post<unknown>(AUTH_PATHS.registration, {
      private_code: flow.privateCode,
      password: parsed.data.password,
      device_label: DEVICE_LABEL,
      token,
    } satisfies RegistrationRequest);

    // Parsed, not cast — backend drift fails here, loudly, instead of leaking
    // undefined into the verify screen (AGENTS.md §4).
    const result = registrationResponseSchema.parse(raw);

    if (result.stage !== STAGE_OTP_REQUIRED) {
      return {
        ok: false,
        error: `Unsupported sign-in stage "${result.stage}"`,
      };
    }

    await updateLoginFlow({
      challengeToken: result.challenge_token,
      challengeExpiresAt: result.challenge_expires_at,
      otpPhone: result.otp.phone,
      otpLength: result.otp.code_length,
      otpResendAvailableIn: result.otp.resend_available_in,
      otpResendsRemaining: result.otp.resends_remaining,
      // The password is deliberately NOT stored — it has been consumed.
    });
  } catch (error) {
    if (error instanceof RegistrationTokenUnavailableError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    return { ok: false, error: message(error, "Invalid code or password") };
  }

  redirect("/login/verify");
}

/** Resend the WhatsApp code (verify screen). Needs a live challenge. */
export async function resendOtpAction(): Promise<ActionState> {
  const flow = await readLoginFlow();
  if (!flow.challengeToken) redirect("/login");

  try {
    // ⏳ Path GUESSED. Body and response follow the confirmed registration
    // pattern: snake_case, carry the token, get the envelope + fresh otp block
    // back — so the verify screen's timer and masked number stay accurate.
    const raw = await api.post<unknown>(AUTH_PATHS.resend, {
      challenge_token: flow.challengeToken,
    });
    const result = registrationResponseSchema.parse(raw);

    await updateLoginFlow({
      stage: result.stage,
      challengeToken: result.challenge_token,
      challengeExpiresAt: result.challenge_expires_at,
      otpPhone: result.otp.phone,
      otpLength: result.otp.code_length,
      otpResendAvailableIn: result.otp.resend_available_in,
      otpResendsRemaining: result.otp.resends_remaining,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    return { ok: false, error: message(error, "Could not resend the code") };
  }
}

/**
 * Step 3 — the WhatsApp code. Never ends in a session directly: the passcode
 * step ALWAYS follows — set it (first login) or enter it (every later login).
 */
export async function verifyOtpAction(code: string): Promise<ActionState> {
  const parsed = otpSchema.safeParse({ code });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  const flow = await readLoginFlow();
  if (!flow.challengeToken) redirect("/login");

  try {
    const raw = await api.post<unknown>(AUTH_PATHS.registrationOtp, {
      challenge_token: flow.challengeToken,
      code: parsed.data.code,
    } satisfies OtpVerifyRequest);

    const result = otpVerifyResponseSchema.parse(raw);

    if (result.stage !== STAGE_PASS_CODE_REQUIRED) {
      return { ok: false, error: `Unsupported sign-in stage "${result.stage}"` };
    }

    await updateLoginFlow({
      stage: result.stage,
      // Store the token the server just returned, not the one we sent — it is
      // re-issued each step and may rotate even when it looks unchanged.
      challengeToken: result.challenge_token,
      challengeExpiresAt: result.challenge_expires_at,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    return { ok: false, error: message(error, "Invalid code") };
  }

  // Outside the try on purpose: redirect() signals by throwing, so calling it
  // inside would be caught above and swallow the navigation.
  //
  // PASS_CODE_REQUIRED sends the admin to SET a passcode rather than enter one,
  // because this whole flow is /v1/registration/* — invitation-based first-time
  // setup (device_label: "setup"). A returning-user login presumably reports a
  // different stage; when that endpoint arrives, branch here.
  redirect("/login/set-passcode");
}

/** Step 4 (first login only) — store the chosen passcode, start the session. */
export async function setPasscodeAction(passcode: string): Promise<ActionState> {
  const parsed = passcodeSchema.safeParse({ passcode });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  const flow = await readLoginFlow();
  if (flow.stage !== STAGE_PASS_CODE_REQUIRED || !flow.challengeToken) {
    redirect("/login");
  }

  let next = "/dashboard";
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.setPasscode, {
      challenge_token: flow.challengeToken,
      pass_code: parsed.data.passcode,
    });

    const result = passCodeResponseSchema.parse(raw);
    if (result.stage !== STAGE_COMPLETED) {
      return { ok: false, error: `Unsupported sign-in stage "${result.stage}"` };
    }

    const { access_token, refresh_token, expires_in, user } = result.tokens;
    await setAuthCookies({
      accessToken: access_token,
      refreshToken: refresh_token,
      accessMaxAge: expires_in,
      // The refresh token never expires; only the cookie ceiling applies.
      refreshMaxAge: REFRESH_MAX_AGE,
    });
    // Kept for the passcode lock screen, which needs it to unlock. This is the
    // only moment it is available in full — /v1/me returns it empty.
    if (user.private_code) {
      await setPrivateCodeCookie(user.private_code, REFRESH_MAX_AGE);
    }

    // The identity step is not optional decoration: the backend states whether
    // this admin still owes a face check or full ID enrolment, and the answer
    // decides where sign-in lands.
    next =
      user.requires_face_verification || user.requires_kyc
        ? "/login/identity"
        : "/dashboard";
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    return { ok: false, error: message(error, "Could not set passcode") };
  }

  await clearLoginFlow();
  redirect(next);
}

/**
 * Passcode entry — the one action behind the passcode screen, covering both
 * moments it appears:
 *   mid-login (unlockToken in the flow cookie, no session yet) → /auth/passcode-login
 *   fresh page load (live refresh cookie = the session)        → /auth/passcode
 */
export async function passcodeUnlockAction(
  passcode: string,
): Promise<ActionState> {
  const parsed = passcodeSchema.safeParse({ passcode });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  // Two ways in: mid-sign-in (the flow cookie carries the code), or the lock
  // screen on a live session (the flow cookie is long gone, so fall back to the
  // code saved at sign-in). Missing both genuinely means "start over".
  const flow = await readLoginFlow();
  const privateCode = flow.privateCode ?? (await getPrivateCode());
  if (!privateCode) redirect("/login");

  let next = "/dashboard";
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.login, {
      private_code: privateCode,
      // `secret` is the 6-digit pass code, NOT the password — see endpoints.ts.
      secret: parsed.data.passcode,
      device_label: DEVICE_LABEL,
    } satisfies LoginRequest);

    const result = loginResponseSchema.parse(raw);
    if (result.stage !== STAGE_COMPLETED) {
      return { ok: false, error: `Unsupported sign-in stage "${result.stage}"` };
    }

    const { access_token, refresh_token, expires_in, user } = result.tokens;
    await setAuthCookies({
      accessToken: access_token,
      refreshToken: refresh_token,
      accessMaxAge: expires_in,
      refreshMaxAge: REFRESH_MAX_AGE,
    });
    // Re-saved: setAuthCookies has just rotated the session, and the lock
    // screen must keep working on the next reload.
    if (user.private_code) {
      await setPrivateCodeCookie(user.private_code, REFRESH_MAX_AGE);
    }

    // Same gate as first-time setup: the backend decides whether identity
    // still has to be proven before the dashboard.
    next =
      user.requires_face_verification || user.requires_kyc
        ? "/login/identity"
        : "/dashboard";
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: "Unexpected response from the sign-in service" };
    }
    // A 401 that is NOT "wrong credentials" means the session or challenge
    // itself died — retrying with the same passcode can never succeed, so only
    // a fresh sign-in recovers.
    //
    // Matched on the error CODE, not the message: this backend answers a wrong
    // passcode with "That code or password is incorrect", so the old text
    // comparison would have classified every mistyped passcode as a dead
    // session and bounced the admin back to the start instead of letting them
    // simply try again.
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      errorCode(error) !== ERROR_CODES.invalidCredentials
    ) {
      await clearLoginFlow();
      await clearAuthCookies();
      redirect("/login");
    }
    return { ok: false, error: message(error, "Invalid passcode") };
  }

  await clearLoginFlow();
  redirect(next);
}

export async function logoutAction() {
  try {
    await api.post(AUTH_PATHS.logout);
  } catch {
    // best-effort server-side revoke; clear local cookies regardless
  }
  await clearAuthCookies();
  await clearLoginFlow();
  // Through the splash → it re-checks (now unauthenticated) and lands on /login.
  redirect("/");
}

import "server-only";
import { cookies } from "next/headers";
import { isProd } from "@/lib/env";

/**
 * Multi-step login flow state (private code → password → OTP → passcode).
 * Each step's short-lived backend token — plus the resolved user's name/role
 * for the screens — rides in ONE httpOnly cookie between steps, so nothing
 * about the flow ever reaches client JS. Cleared the moment a session exists.
 */
const COOKIE = "root_login_flow";
const MAX_AGE = 600; // seconds — matches the backend's step-token lifetimes

export type LoginFlowState = {
  /**
   * The private code from step 1.
   *
   * Carried rather than exchanged: POST /v1/registration needs the private code
   * and the password TOGETHER, but the XD collects them on two screens. There
   * is no endpoint that validates the code alone, so step 1 just holds it.
   *
   * It is a credential, so it lives here exactly like the step tokens do —
   * httpOnly, sameSite, expiring in MAX_AGE seconds, never readable from client
   * JS — and is cleared the moment a session exists. The password is NEVER
   * stored; it goes straight into the one call that consumes it.
   */
  privateCode?: string;
  /**
   * The backend's own state machine position — "OTP_REQUIRED",
   * "PASS_CODE_REQUIRED", … Re-issued at every step and used to gate screens.
   *
   * This replaces the deleted backend's per-step tokens (`setupToken`,
   * `unlockToken`): that design proved which step you had reached by giving you
   * a different token for each. This one keeps ONE `challengeToken` throughout
   * and names the step separately, so screens gate on `stage` + a live token.
   */
  stage?: string;
  /** Re-issued by every registration step; proves the flow so far. */
  challengeToken?: string;
  /** From /v1/registration — when the challenge itself dies (ISO string). */
  challengeExpiresAt?: string;
  /** Masked destination for display, e.g. "•••••••••540". */
  otpPhone?: string;
  /** Digit count of the OTP — drives the input box count. */
  otpLength?: number;
  /** Seconds before "resend" may be pressed — drives the resend timer. */
  otpResendAvailableIn?: number;
  /** How many resends the backend will still honour. */
  otpResendsRemaining?: number;
  /**
   * Display only — nothing populates these yet. No endpoint resolves a private
   * code on its own, so the admin stays anonymous until sign-in completes.
   */
  name?: string;
  role?: string;
};

export async function readLoginFlow(): Promise<LoginFlowState> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as LoginFlowState;
  } catch {
    return {};
  }
}

/** Merges `patch` into the current state. Server Actions only. */
export async function updateLoginFlow(patch: LoginFlowState) {
  const current = await readLoginFlow();
  (await cookies()).set(COOKIE, JSON.stringify({ ...current, ...patch }), {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearLoginFlow() {
  (await cookies()).delete(COOKIE);
}

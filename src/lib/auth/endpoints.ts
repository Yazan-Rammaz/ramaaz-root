import { z } from "zod";

/**
 * THE auth contract — every path, request and response shape the login flow
 * uses, in one place.
 *
 * Base URL is `NEST_API_URL` (staging: http://staging-backend.ramaaz.store).
 *
 * ── Two generations live here ───────────────────────────────────────────────
 * ✅ MIGRATED  — confirmed against the real backend, snake_case wire format.
 * ⏳ PENDING   — still the shapes of the deleted local `root-backend`. They are
 *               camelCase and almost certainly wrong; each is replaced as its
 *               real endpoint arrives.
 *
 * No `server-only` here on purpose: these are paths, schemas and types with no
 * secrets, and edge middleware imports them too.
 */

/* ─────────────────────────── paths ─────────────────────────── */

export const AUTH_PATHS = {
  /** ✅ Private code + password → OTP challenge. Collapses what used to be two
   *  calls (`/auth/identify` then `/auth/login`) into one. */
  registration: "/v1/registration",
  /** ✅ WhatsApp OTP code → next stage (PASS_CODE_REQUIRED). */
  registrationOtp: "/v1/registration/otp",

  /** ✅ Re-send the WhatsApp OTP. Takes `{ challenge_token }`. Path confirmed
   *  against staging; response shape still unverified. */
  resend: "/v1/registration/otp/resend",
  /** ✅ Store the chosen passcode. Takes `{ challenge_token, pass_code }` —
   *  note `pass_code`, and the HYPHEN in the path. Both confirmed against
   *  staging; response shape still unverified. */
  setPasscode: "/v1/registration/pass-code",

  /** ✅ Returning-user login (private code + password), as opposed to the
   *  invitation-based /v1/registration flow. Exists — it answers
   *  INVALID_CREDENTIALS — but its request/response shapes are unknown. */
  login: "/v1/auth/login",
  /** ✅ The authoritative session read. GET, Bearer access token. Exists;
   *  response shape unverified. */
  me: "/v1/me",

  /**
   * ✅ Silent refresh. Takes `{ refresh_token }` in the BODY (no bearer) and
   * answers 200 with `access_token` at the TOP level — not nested under
   * `tokens` the way /registration/pass-code is.
   *
   * ⚠️ Single-use, and rotated on every call. Replaying a spent refresh token
   * returns TOKEN_REUSED and the backend KILLS THE WHOLE SESSION — it reads a
   * replay as theft. Never retry a failed refresh with the same token, and
   * never let two requests refresh concurrently.
   */
  refresh: "/v1/auth/refresh",
  /** ✅ Best-effort server-side revoke. Bearer access token. */
  logout: "/v1/auth/logout",

  /** ⏳ Mid-login passcode entry (unlock token, no session yet). Not found on
   *  staging — belongs to the returning-user flow, still to be provided. */
  passcodeLogin: "/auth/passcode-login",
  /** ⏳ Passcode entry on a device with a live refresh cookie. */
  passcode: "/auth/passcode",
} as const;

/* ─────────────────────── error envelope ─────────────────────── */

/**
 * Every error response from this backend, confirmed against staging:
 *
 *   401 { error: { code: "UNAUTHENTICATED",    message, correlation_id } }
 *   422 { error: { code: "VALIDATION_FAILED",  message, fields, correlation_id } }
 *
 * The message is nested under `error`, NOT top-level — `lib/api/server.ts`
 * reads it via `errorMessage()`. `correlation_id` is what support needs to
 * trace a failed login in the backend's logs.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Per-field validation detail, e.g. `{ token: "is required" }`. */
    fields: z.record(z.string(), z.string()).optional(),
    correlation_id: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** Error codes seen on staging. */
export const ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  validationFailed: "VALIDATION_FAILED",
  /** Wrong private code / password / pass code — the user can just retry. */
  invalidCredentials: "INVALID_CREDENTIALS",
  /** The registration challenge expired or was consumed — restart sign-in. */
  challengeInvalid: "CHALLENGE_INVALID",
  /** Access token past its `expires_at` — refresh and retry. */
  tokenExpired: "TOKEN_EXPIRED",
  /** A spent refresh token was replayed; the backend ENDS THE SESSION. */
  tokenReused: "TOKEN_REUSED",
  notFound: "NOT_FOUND",
} as const;

/* ─────────────────── ✅ POST /v1/registration ─────────────────── */

/**
 * The wire format is snake_case — unlike the old local backend. Request and
 * response schemas keep that shape exactly; nothing is renamed on the way out,
 * and the response is mapped to camelCase only after parsing.
 */
export const registrationRequestSchema = z.object({
  private_code: z.string(),
  password: z.string(),
  /** Identifies the device this login is bound to. */
  device_label: z.string(),
  /** Pre-issued token supplied with the credentials (see `getRegistrationToken`). */
  token: z.string(),
});
export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

/**
 * OTP delivery metadata. Everything the verify screen needs to describe the
 * message that was just sent, without the frontend guessing any of it.
 */
export const otpChallengeSchema = z.object({
  /** Masked destination, e.g. "•••••••••540". Safe to display. */
  phone: z.string(),
  channel: z.string(),
  /** How many digits the code has — drives the input box count. */
  code_length: z.number().int().positive(),
  expires_at: z.string(),
  /** Seconds until the code dies. */
  expires_in: z.number().int(),
  /** Seconds before "resend" may be pressed — drives the resend timer. */
  resend_available_in: z.number().int(),
  resends_remaining: z.number().int(),
  delivered: z.boolean(),
});

/**
 * The envelope every step of the registration flow returns: where you are now,
 * the token that proves it, and when that token dies. Each step extends it with
 * whatever else that step produces.
 */
const challengeEnvelope = z.object({
  /** Open string, not an enum: an unrecognised stage should parse and then be
   *  rejected in one explicit place, not fail as a confusing schema error. */
  stage: z.string(),
  /** Re-issued at every step — always store the one just returned, never the
   *  one you sent, so a rotation can't silently invalidate the flow. */
  challenge_token: z.string(),
  /**
   * Plain string, NOT `z.string().datetime()`. Precision varies per endpoint —
   * nanoseconds from /registration ("…58.56108563Z"), milliseconds from
   * /registration/otp ("…58.556Z") — and zod's datetime() rejects more than
   * three fractional digits, which would fail every single login.
   */
  challenge_expires_at: z.string(),
});

export const registrationResponseSchema = challengeEnvelope.extend({
  otp: otpChallengeSchema,
});
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

/* ───────────────── ✅ POST /v1/registration/otp ───────────────── */

export const otpVerifyRequestSchema = z.object({
  challenge_token: z.string(),
  code: z.string(),
});
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

/** Same envelope, no extra payload — the stage is the whole answer. */
export const otpVerifyResponseSchema = challengeEnvelope;
export type OtpVerifyResponse = z.infer<typeof otpVerifyResponseSchema>;

/* ──────────────────────────── stages ──────────────────────────── */

/** After /registration — a code has been sent, enter it. */
export const STAGE_OTP_REQUIRED = "OTP_REQUIRED";
/** After /registration/otp — choose a passcode. */
export const STAGE_PASS_CODE_REQUIRED = "PASS_CODE_REQUIRED";
/** After /registration/pass-code — signed in; tokens issued. */
export const STAGE_COMPLETED = "COMPLETED";

/* ─────────────── ✅ POST /v1/registration/pass-code ─────────────── */

/**
 * The signed-in admin, as the backend describes them.
 *
 * Note what is NOT here: no role, and no split name. `is_root` is the only
 * privilege signal, and `full_name` is one string — both are mapped in
 * `lib/auth/session.ts` rather than reshaped here, so this stays a faithful
 * record of the wire format.
 */
export const wireUserSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  status: z.string(),
  /** The only privilege flag the API exposes. */
  is_root: z.boolean(),

  /**
   * ── Only fully populated by the sign-in responses ────────────────────────
   * GET /v1/me returns a SPARSE projection of the same object: `phone` is
   * absent entirely and the rest come back as Go zero values (`""`,
   * "0001-01-01T00:00:00Z"). They are optional so a session read does not
   * explode — requiring `phone` here made getSession() throw on every request,
   * which redirected every protected page to /login forever.
   */
  private_code: z.string().optional(),
  /** Unmasked, unlike the masked `otp.phone` shown mid-flow. Absent from /v1/me. */
  phone: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  created_at: z.string().optional(),
  /** Only sent by /v1/auth/refresh — absent from the sign-in responses. */
  last_login_at: z.string().optional(),
  /** ⚠️ Unreliable from /v1/me — it reported `false` for an admin who had just
   *  set one. Trust it only from a sign-in response. */
  has_pass_code: z.boolean(),
  /**
   * The two flags the identity step has been waiting for (SCENARIOS.md §4c):
   * whether this admin must pass a live face check, and whether they still
   * need full ID enrolment.
   */
  requires_face_verification: z.boolean(),
  requires_kyc: z.boolean(),
});
export type WireUser = z.infer<typeof wireUserSchema>;

export const wireTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(),
  expires_at: z.string(),
  /**
   * Seconds until the ACCESS token dies (~899 = 15 min). There is no
   * equivalent for the refresh token — see REFRESH_MAX_AGE.
   */
  expires_in: z.number().int(),
  user: wireUserSchema,
});

/** Tokens are nested under `tokens` here — unlike /v1/auth/refresh, which
 *  returns `access_token` at the top level. */
export const passCodeResponseSchema = z.object({
  stage: z.string(),
  tokens: wireTokensSchema,
});
export type PassCodeResponse = z.infer<typeof passCodeResponseSchema>;

/* ─────────────────── ✅ POST /v1/auth/login ─────────────────── */

/**
 * Returning-user sign-in — one call, no OTP. Distinct from the invitation-based
 * /v1/registration/* flow, which is first-time setup only.
 *
 * `secret` is the 6-DIGIT PASS CODE, not the password: staging accepts the
 * value set via /v1/registration/pass-code and answers COMPLETED, and the
 * password schema requires 8+ characters, so a password could not be this
 * value. `device_label` is accepted empty here.
 */
export const loginRequestSchema = z.object({
  private_code: z.string(),
  secret: z.string(),
  device_label: z.string(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Identical envelope to /registration/pass-code. */
export const loginResponseSchema = passCodeResponseSchema;

/* ─────────────────── ✅ POST /v1/auth/refresh ─────────────────── */

/**
 * Exactly the token block the sign-in responses nest under `tokens` — but
 * returned at the TOP level here, which is the one shape difference between
 * this endpoint and the others.
 *
 * Its `user` is FULLY populated (phone, private_code, locale, …), unlike the
 * sparse projection GET /v1/me returns. So a refresh is a more trustworthy
 * source of the KYC flags than the session read is.
 */
export const refreshResponseSchema = wireTokensSchema;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/* ────────────────────── ✅ GET /v1/me ────────────────────── */

/**
 * The session read. Wrapped in `user` — and it also carries `projects`, which
 * looks like the systems registry the dashboard lost when root-backend was
 * deleted. Shape of a project entry is unknown (the array was empty), so it is
 * passed through unvalidated rather than guessed at.
 */
export const meResponseSchema = z.object({
  user: wireUserSchema,
  projects: z.array(z.unknown()).optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * How long to keep the refresh cookie.
 *
 * ⚠️ ASSUMPTION — the API returns `expires_in` for the access token only and
 * says nothing about the refresh token's lifetime. 30 days is a guess. Both
 * ways of being wrong degrade safely: too long and a refresh simply fails and
 * sends the admin to /login; too short and they sign in again sooner.
 */
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

/* ─────────────────── ⏳ awaiting real endpoints ─────────────────── */

/** What every session-opening endpoint returns. Shape UNVERIFIED. */
export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  accessMaxAge: number;
  refreshMaxAge: number;
};

/** `resend` — a refreshed OTP challenge. Shape UNVERIFIED. */
export type ChallengeResponse = {
  challengeToken: string;
};

/**
 * `verify` — the OTP was right, and the passcode step ALWAYS follows: set one
 * on a first login, enter the existing one otherwise. Shape UNVERIFIED.
 */
export type VerifyResponse =
  | { stage: "set-passcode"; setupToken: string }
  | { stage: "enter-passcode"; unlockToken: string };

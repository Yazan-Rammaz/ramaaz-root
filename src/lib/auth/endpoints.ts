import { z } from "zod";

/**
 * THE auth contract — every path, request and response shape the sign-in flow
 * uses, in one place.
 *
 * Base URL is `NEST_API_URL` (staging: https://staging-backend.ramaaz.store).
 *
 * ── The protocol, in one picture ────────────────────────────────────────────
 * Sign-in is ONE state machine with two paths through it. The server decides
 * which, and says so in `stage` on every response:
 *
 *   FIRST LOGIN   link → private-code → face → id-document → id-info → device
 *   LATER LOGINS  link → device → face
 *
 * See `root-enrollment.md` in the workspace root for the authoritative writeup.
 *
 * ── Four rules that hold for every step ─────────────────────────────────────
 *  1. ONE challenge token for the whole attempt — it does NOT rotate. Every
 *     response echoes the same value. It is a signed JWT whose `sub` is the
 *     administrator's id, but treat it as opaque: the row behind it decides the
 *     stage, so a token that verifies is not a token that works.
 *  2. Branch on `stage`, never on a step counter — a check switched off in a
 *     deployment simply never reports its stage, and a client walking a
 *     hard-coded list would send a request the server refuses.
 *  3. The whole sequence expires (AUTH_CHALLENGE_TTL, 10 min) and tolerates 5
 *     failed attempts across ALL steps combined. Past either, restart at /link.
 *  4. Order is enforced server-side. A step sent early answers CHALLENGE_INVALID
 *     with no hint about what was expected instead.
 *
 * ── Status against staging (probed 2026-08-26) ──────────────────────────────
 *  ✅ live      /v1/auth/link · /private-code · /face · /device/options · /device
 *  ❌ 404       /v1/auth/identity-document · /v1/auth/identity-info
 *  ⚰️ removed   /v1/registration/*  — the old password+OTP+PIN flow is GONE.
 *
 * No `server-only` here on purpose: these are paths, schemas and types with no
 * secrets, and edge middleware imports them too.
 */

/* ─────────────────────────── paths ─────────────────────────── */

export const AUTH_PATHS = {
  /**
   * ✅ Step 1. Opens a challenge from the access link's token. Takes
   * `{ token, device_label? }` — the token goes in the BODY, never in a URL of
   * our own: a path segment lands in access logs, proxy logs and history.
   *
   * Refusals (unknown / revoked / expired link, address range, country,
   * suspended account) are deliberately indistinguishable and all answer
   * UNAUTHENTICATED. Do not try to tell them apart.
   */
  link: "/v1/auth/link",

  /**
   * ✅ Step 2. The code the administrator PULLS over WhatsApp by messaging the
   * trigger phrase from their registered handset — there is no endpoint that
   * sends it, and deliberately is not one: a code the console could request on
   * someone's behalf would prove nothing about who holds the link.
   *
   * Consequence for the UI: there is NO RESEND CALL. They message again.
   */
  privateCode: "/v1/auth/private-code",

  /**
   * ✅ Face check. Runs on EVERY sign-in — step 4 on a first login, and the
   * final step before COMPLETED on every later one.
   *
   * ⚠️ The verifier is a stub today: it accepts any well-formed `evidence`
   * object and returns success. Build the capture for real, but never present
   * the result to anyone as a verified identity.
   */
  face: "/v1/auth/face",

  /**
   * First-login ID enrolment — and MID-MIGRATION, so read this before sending
   * anything.
   *
   * ⚠️ The base64 payload this accepts today is going away. `root-enrollment.md`
   * §5: *"do not build against the payload below… that path is going away."*
   * It will take `evidence: { step_token }`, minted by `POST /v1/kyc/submit`,
   * exactly as `/auth/face` does — the document is a photograph of a government
   * ID with a face on it, so every argument for keeping the selfie out of the
   * auth backend applies to it with more force, not less.
   *
   * It has not moved yet only because `/v1/kyc/submit` is not built: the
   * backend is waiting on the KYC side's payload schema. Until then the stub
   * accepts what it always did, and we send it — narrowly, so the sequence can
   * be walked to the device step. See `StubDocumentEvidence` in
   * `features/auth/actions.ts` for the swap.
   *
   * There is deliberately no companion `identity-info`. That existed when
   * the protocol expected the administrator to TYPE their ID details as a
   * separate step; OCR removed it, so no second user action was left for a
   * second stage to wait on. See docs/kyc/backend.md, decision 7.
   */
  identityDocument: "/v1/auth/identity-document",

  /**
   * ✅ Ask for the WebAuthn ceremony. Answers `{ mode, publicKey }`, where
   * `mode` ("register" | "authenticate") decides which browser call to make.
   * The SERVER decides that from what the link has already enrolled — never
   * pick it client-side, that is what stops a stranger asking to "register" on
   * a link that is already bound.
   *
   * A `label` sent here is accepted and IGNORED; send it to `device` instead.
   */
  deviceOptions: "/v1/auth/device/options",
  /**
   * ✅ Submit the ceremony's answer, plus the `label` that IS stored and shown
   * in the administrator's credential list.
   *
   * On a first login this binds the link to this passkey permanently — the
   * trusted device. From then on the link opens from this device and no other,
   * and a lost device is NOT self-recoverable: the only path is another root
   * administrator issuing a fresh link.
   */
  device: "/v1/auth/device",

  /**
   * ⚠️ BROKEN — DO NOT CALL. Nothing in this app does.
   *
   * This was the authoritative session read, and while it was failing
   * `getSession()` answered `null` for everybody: every protected page decided
   * nobody was signed in and redirected to /login. A signed-in administrator
   * could not reach the dashboard.
   *
   * The session now comes from the user the COMPLETED response already carried,
   * kept in an httpOnly cookie — see `lib/auth/session.ts`, which states plainly
   * what that gives up.
   *
   * Kept here, with its schema, so restoring the endpoint is a one-line change
   * rather than an excavation. Re-point `getSession()` at it and delete the
   * cookie; nothing else in the flow depends on the substitution.
   */
  me: "/v1/me",

  /**
   * ✅ Silent refresh. Takes `{ refresh_token }` in the BODY (no bearer) and
   * answers 200 with `access_token` at the TOP level — not nested under
   * `tokens` the way the sign-in responses are.
   *
   * ⚠️ Single-use, and rotated on every call. Replaying a spent refresh token
   * returns TOKEN_REUSED and the backend KILLS THE WHOLE SESSION — it reads a
   * replay as theft. Never retry a failed refresh with the same token, and
   * never let two requests refresh concurrently.
   */
  refresh: "/v1/auth/refresh",
  /** ✅ Best-effort server-side revoke. Bearer access token. */
  logout: "/v1/auth/logout",
} as const;

/* ─────────────────────── error envelope ─────────────────────── */

/**
 * Every error response from this backend, confirmed against staging:
 *
 *   401 { error: { code: "UNAUTHENTICATED",   message, correlation_id } }
 *   404 { error: { code: "NOT_FOUND",         message, correlation_id } }
 *   422 { error: { code: "VALIDATION_FAILED", message, fields, correlation_id } }
 *
 * The message is nested under `error`, NOT top-level — `lib/api/server.ts`
 * reads it via `errorMessage()`. `correlation_id` is what support needs to
 * trace a failed sign-in in the backend's logs, so surface it on hard failures.
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

/** Error codes worth handling by name. */
export const ERROR_CODES = {
  /**
   * The link is unknown, revoked, expired, outside its address range or
   * country — or the account is suspended. ONE message covers all of them,
   * because the server gives one. Never guess which condition tripped.
   */
  unauthenticated: "UNAUTHENTICATED",
  /** A missing field, or `evidence` that is not an object with ≥1 key. */
  validationFailed: "VALIDATION_FAILED",
  /**
   * Expired, already used, burned by too many failures, or a step sent out of
   * order. Restart at /auth/link — do NOT retry the step.
   */
  challengeInvalid: "CHALLENGE_INVALID",
  /** Wrong private code — costs an attempt, but the user can simply retry. */
  invalidCredentials: "INVALID_CREDENTIALS",
  /** Private-code requests from one number: five per fifteen minutes. */
  rateLimited: "RATE_LIMITED",
  /**
   * The WhatsApp or one-time-code gateway is down. Say the SERVICE is
   * unavailable — never that the code was wrong. Retrying is safe.
   */
  serviceUnavailable: "SERVICE_UNAVAILABLE",
  /** Access token past its `expires_at` — refresh and retry. */
  tokenExpired: "TOKEN_EXPIRED",
  /** A spent refresh token was replayed; the backend ENDS THE SESSION. */
  tokenReused: "TOKEN_REUSED",
  notFound: "NOT_FOUND",
} as const;

/* ──────────────────────────── stages ──────────────────────────── */

/**
 * The server's own state-machine positions. These are the ONLY thing that
 * decides which screen comes next.
 *
 * ⚠️ Pinned backend-side by `TestAPIStageNames` in
 * `internal/service/sequence_test.go`. A rename there is a breaking change for
 * every screen built from this contract.
 */
export const STAGES = {
  /** Message WhatsApp, then type the code that comes back. */
  privateCode: "PRIVATE_CODE_REQUIRED",
  /** Live face capture. Both first and later logins. */
  face: "FACE_REQUIRED",
  /**
   * First login only — the whole ID enrolment: capture, OCR, confirm, submit.
   *
   * One stage, not two. `ID_INFO_REQUIRED` is gone because a stage exists to
   * say "the server is blocked until you send something", and once the summary
   * has been confirmed there is nothing further to send.
   */
  idDocument: "ID_DOCUMENT_REQUIRED",
  /** WebAuthn ceremony: enrol this device, or prove it. */
  device: "DEVICE_REQUIRED",
  /** Signed in; `tokens` is present on this response and nowhere else. */
  completed: "COMPLETED",
} as const;

export type Stage = (typeof STAGES)[keyof typeof STAGES];

/**
 * Stage → the screen that answers it. THE routing table: every step handler
 * returns here rather than naming its own successor, so the server stays in
 * charge of the order (rule 2 above) and a disabled check simply skips.
 *
 * COMPLETED is absent on purpose — it is not a screen, it is the end, and it
 * is handled explicitly where tokens are stored.
 */
export const STAGE_ROUTES: Record<string, string> = {
  [STAGES.privateCode]: "/login",

  /**
   * ⚠️ Three stages, ONE route — and this is load-bearing, not tidiness.
   *
   * The face captured at FACE_REQUIRED is reused when the ID is compared
   * against it, so the administrator never captures their face twice. That
   * frame is a ~300 KB data URL living in React state: far too large for a
   * cookie, and biometric data we will not put in browser storage.
   *
   * So it survives exactly as long as the React tree does. Give these stages
   * separate URLs and navigating between them unmounts everything and drops the
   * frame — silently, with the only symptom being a second face capture nobody
   * asked for.
   *
   * `/login/identity` therefore hosts the whole identity flow and picks its
   * entry step from the stage.
   */
  [STAGES.face]: "/login/identity",
  [STAGES.idDocument]: "/login/identity",

  [STAGES.device]: "/login/device",
};

/* ─────────────────── POST /v1/auth/link ─────────────────── */

/**
 * The access link's token — the last path segment of the link the
 * administrator was issued.
 *
 * Lives here rather than in `features/auth/schema.ts` because `lib/auth/link.ts`
 * is what validates it, and `lib` must not import from `features`.
 */
export const linkTokenSchema = z.object({
  token: z.string().min(16, "That link is not valid").max(256),
});
export type LinkTokenInput = z.infer<typeof linkTokenSchema>;

export const linkRequestSchema = z.object({
  /** The last path segment of the access link. Sent in the body, never a URL. */
  token: z.string(),
  /** Optional. Names the SESSION, not the passkey — the passkey label is sent
   *  to /auth/device instead. */
  device_label: z.string().optional(),
});
export type LinkRequest = z.infer<typeof linkRequestSchema>;

/* ─────────────── POST /v1/auth/private-code ─────────────── */

export const privateCodeRequestSchema = z.object({
  challenge_token: z.string(),
  code: z.string(),
});
export type PrivateCodeRequest = z.infer<typeof privateCodeRequestSchema>;

/* ───────── POST /v1/auth/{face,identity-document,identity-info} ───────── */

/**
 * The three stub-verified steps share one request shape.
 *
 * `evidence` is free-form: the server checks ONLY that it is an object with at
 * least one key, and passes whatever is inside to the future provider
 * verbatim. So the field names below are a SUGGESTION, not a contract — settle
 * them with whoever implements the providers before hard-coding them.
 */
export const evidenceRequestSchema = z.object({
  challenge_token: z.string(),
  evidence: z.record(z.string(), z.unknown()),
});
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;

/* ──────────────── POST /v1/auth/device/options ──────────────── */

/**
 * `publicKey` is deliberately NOT parsed field-by-field. It is a WebAuthn
 * options object that the browser validates far more strictly than we could,
 * and re-describing it here would mean this file breaking every time the spec
 * or the server's algorithm list moves. `mode` is the part we branch on, so
 * that is the part that is checked.
 *
 * Its binary fields (`challenge`, `user.id`, `excludeCredentials[].id`,
 * `allowCredentials[].id`) arrive as base64url STRINGS and must become
 * ArrayBuffers before `navigator.credentials.*` will accept them — the single
 * most common integration failure on this endpoint. See lib/auth/webauthn.ts.
 */
export const deviceOptionsResponseSchema = z.object({
  /** "register" → credentials.create(); "authenticate" → credentials.get(). */
  mode: z.enum(["register", "authenticate"]),
  publicKey: z.record(z.string(), z.unknown()),
});
export type DeviceOptionsResponse = z.infer<typeof deviceOptionsResponseSchema>;

export const deviceRequestSchema = z.object({
  challenge_token: z.string(),
  /** Stored, and shown to the administrator in their credential list. */
  label: z.string().optional(),
  /** `PublicKeyCredential.toJSON()` output, passed through untouched. */
  credential: z.record(z.string(), z.unknown()),
});
export type DeviceRequest = z.infer<typeof deviceRequestSchema>;

/* ─────────────────────── step responses ─────────────────────── */

/**
 * The signed-in admin, as the backend describes them.
 *
 * Note what is NOT here: no role, and no split name. `is_root` is the only
 * privilege signal, and `full_name` is one string — both are mapped in
 * `lib/auth/session.ts` rather than reshaped here, so this stays a faithful
 * record of the wire format.
 *
 * Almost everything is optional because the same shape is returned by three
 * endpoints with three different levels of detail: the COMPLETED response is
 * the fullest, /v1/auth/refresh is close behind, and GET /v1/me returns a
 * SPARSE projection where absent fields come back as Go zero values (`""`,
 * "0001-01-01T00:00:00Z"). Requiring any of them made getSession() throw on
 * every request, which redirected every protected page to /login forever.
 */
export const wireUserSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  status: z.string(),
  /** The only privilege flag the API exposes. */
  is_root: z.boolean(),

  /**
   * ⚠️ Stays `false` FOREVER on a root account — there is no PIN in this
   * protocol; the passkey replaced it. A UI that reads this as "setup
   * incomplete" shows a permanent setup prompt to somebody fully enrolled.
   */
  has_pass_code: z.boolean().optional(),

  private_code: z.string().optional(),
  phone: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  created_at: z.string().optional(),
  last_login_at: z.string().optional(),

  /**
   * Left over from the previous contract, where identity was proven AFTER
   * sign-in. It no longer decides anything: the face and ID steps now run
   * INSIDE the challenge, before a token exists, and `stage` is what reports
   * them. Optional so a payload without them still parses.
   */
  requires_face_verification: z.boolean().optional(),
  requires_kyc: z.boolean().optional(),
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
export type WireTokens = z.infer<typeof wireTokensSchema>;

/**
 * ONE response shape for every step of the flow.
 *
 * Deliberately not a discriminated union on `stage`: an unrecognised stage
 * must PARSE and then be rejected in one explicit place (`applyStage`), rather
 * than surfacing as a confusing schema error three layers down.
 *
 * `challenge_token` is optional only because COMPLETED omits it — the flow is
 * over and there is nothing left to prove. `tokens` is present on COMPLETED
 * and nowhere else.
 */
export const stepResponseSchema = z.object({
  stage: z.string(),
  challenge_token: z.string().optional(),
  /**
   * Stable for the whole attempt, and NOT a credential — which is exactly why
   * it exists separately from the token. It is what identifies this sign-in to
   * the KYC Worker, so it travels in request bodies and appears in logs, and
   * the token must never be used for that.
   */
  challenge_id: z.string().optional(),
  /**
   * Plain string, NOT `z.string().datetime()`. Precision varies per endpoint —
   * nanoseconds from some, milliseconds from others — and zod's datetime()
   * rejects more than three fractional digits, which would fail every sign-in.
   */
  challenge_expires_at: z.string().optional(),
  /**
   * Where the face captured during this sign-in is stored — a URL, not an
   * image. The KYC Worker commits the frame Rekognition judged, and the backend
   * hands back a link to it.
   *
   * Returned on `/v1/auth/link` when the stage is ID_DOCUMENT_REQUIRED, which
   * is what lets a REFRESH part-way through enrolment still show the face. The
   * frame itself lives in React state and dies with the page; this outlives it.
   *
   * A URL is why this works at all. The image is ~300KB of base64, far past a
   * cookie's 4KB ceiling — a link is a hundred characters and rides in the
   * challenge cookie with everything else.
   *
   * ⚠️ For DISPLAY only, and never fetched by the browser: it points at the
   * backend, which the browser must never address (AGENTS.md §2), and the CSP
   * would refuse it anyway. `/api/face-capture` fetches it server-side.
   */
  face_capture_url: z.string().optional(),
  tokens: wireTokensSchema.optional(),
});
export type StepResponse = z.infer<typeof stepResponseSchema>;

/* ────────────────────── GET /v1/me ────────────────────── */

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

/* ─────────────────── POST /v1/auth/refresh ─────────────────── */

/**
 * Exactly the token block the sign-in response nests under `tokens` — but
 * returned at the TOP level here, which is the one shape difference between
 * this endpoint and the others.
 */
export const refreshResponseSchema = wireTokensSchema;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/* ──────────────────────── lifetimes ──────────────────────── */

/**
 * How long to keep the refresh cookie.
 *
 * CONFIRMED: the refresh token does not expire. It is single-use — every
 * refresh returns a replacement — but the chain itself has no time limit, and
 * the API returns `expires_in` for the ACCESS token only.
 *
 * So the cookie should outlive nothing but the browser's own ceiling: 400 days
 * is the maximum a cookie may declare (browsers clamp anything longer), and
 * anything shorter would sign the admin out while their token was still
 * perfectly valid.
 *
 * A session therefore ends in exactly three ways: an explicit sign-out, a
 * replayed refresh token (reuse detection kills the whole family — see
 * AUTH_PATHS.refresh), or the browser dropping the cookie.
 */
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 400;

/**
 * How long the whole challenge lives, per `AUTH_CHALLENGE_TTL` backend-side.
 * Used only as the flow cookie's ceiling — `challenge_expires_at` from the
 * server is the authoritative deadline and is what the countdown reads.
 */
export const CHALLENGE_MAX_AGE = 10 * 60;

/**
 * `ROOT_PRIVATE_CODE_TTL`. Short by design, and SHORTER THAN WHATSAPP DELIVERY
 * OFTEN TAKES — so the private-code screen shows a live countdown and keeps
 * the "message the number again" instruction permanently on screen rather than
 * in a one-time toast. There is no resend endpoint to offer instead.
 */
export const PRIVATE_CODE_TTL = 50;

/**
 * The token pair, in the shape the cookie layer wants it — camelCase, with
 * both lifetimes resolved to seconds.
 *
 * Not a wire shape: it is what `lib/auth/refresh.ts` hands to middleware, which
 * runs on the edge and must not know that the access token's life comes from
 * the response while the refresh token's comes from REFRESH_MAX_AGE.
 */
export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  /** seconds */
  accessMaxAge: number;
  /** seconds */
  refreshMaxAge: number;
};

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
 *   FIRST LOGIN   link → private-code → face → id-document → COMPLETED
 *   LATER LOGINS  link → face → COMPLETED
 *
 * ⚠️ DEVICE VERIFICATION IS OFF (`ROOT_REQUIRE_DEVICE=false` — see
 * `backend docs/frontend-security-changes.md` §0), which is why neither path
 * ends at a passkey. Nothing here was deleted: DEVICE_REQUIRED simply never
 * arrives, `/login/device` is never routed to, and the two device endpoints
 * answer 412 PRECONDITION_FAILED if called. The setting is reversible in one
 * line backend-side, and rule 2 below is what makes that free in either
 * direction.
 *
 * Consequence worth naming: a first login now ENDS at
 * `/v1/auth/identity-document`. That call returns COMPLETED with the token
 * pair, where it used to return DEVICE_REQUIRED.
 *
 * See `backend docs/root-enrollment.md` for the authoritative writeup, and
 * `backend docs/frontend-security-changes.md` for the current change notes —
 * the latter wins where the two disagree, and they do (see rule 3).
 *
 * ── Four rules that hold for every step ─────────────────────────────────────
 *  1. ONE challenge token for the whole attempt — it does NOT rotate. Every
 *     response echoes the same value. It is a signed JWT whose `sub` is the
 *     administrator's id, but treat it as opaque: the row behind it decides the
 *     stage, so a token that verifies is not a token that works.
 *  2. Branch on `stage`, never on a step counter — a check switched off in a
 *     deployment simply never reports its stage, and a client walking a
 *     hard-coded list would send a request the server refuses.
 *  3. The whole sequence expires (AUTH_CHALLENGE_TTL, 10 min) and burns after
 *     repeated failures. Past either, restart at /link.
 *
 *     TWO counters, and both apply (§6 of the change notes):
 *       per sign-in   every failed step — private code, face, document — charges
 *                     it. Exhausted → CHALLENGE_INVALID, restart at /link.
 *       per account   wrong PRIVATE CODES only. Five → locked 15 minutes.
 *
 *     The document step has its own ceiling of 3 tries inside the sign-in, and a
 *     failure charges both counters.
 *
 *     ⚠️ THE NUMBERS ARE DISPUTED. The change notes say 20 attempts per sign-in
 *     and a 500-second private code; `root-enrollment.md` still says 5 and 50.
 *     Open with the backend — and the reason nothing here hard-codes either.
 *
 *     ⚠️ NEVER COUNT ATTEMPTS HERE. The server charges them and says on every
 *     response whether another try is possible. A counter in this app can only
 *     disagree, and it disagrees by refusing somebody the server would allow.
 *
 *     The account lock is INVISIBLE on purpose: a locked account answers the
 *     same 401 UNAUTHENTICATED that one wrong code does, with the same sentence.
 *     Never try to detect it and never label it — telling an unauthenticated
 *     caller that an account is locked tells someone guessing that their
 *     guessing is working. (It used to answer INVALID_CREDENTIALS, which made
 *     the lock visible. That was a bug and is fixed, so that code should no
 *     longer appear on this flow at all.)
 *
 *     A locked administrator can still open links and walk to the code screen.
 *     That is deliberate for the same reason — a link that refused during a lock
 *     would disclose the lock to whoever holds the link.
 *  4. Order is enforced server-side. A step sent early answers 412
 *     PRECONDITION_FAILED with `details.stage` naming where the challenge really
 *     is — so a client that lost track can route on that rather than restart.
 *     A step sent against a DEAD challenge answers 401 CHALLENGE_INVALID first.
 *
 * ── Status against staging (confirmed by the backend 2026-09-22) ────────────
 *  ✅ live      /v1/auth/link · /private-code · /face · /identity-document
 *  ✅ real      the face and document checks are Rekognition-backed, not stubs.
 *               Staging thresholds are ~1% for testing, so almost any live face
 *               passes there; production will be strict. Exercise the FAILURE
 *               screens deliberately — staging will not produce them for you.
 *  🚫 412       /v1/auth/device/options · /v1/auth/device — dormant while
 *               device verification is off. The routes exist; no challenge ever
 *               sits at DEVICE, so they refuse.
 *  ⚰️ removed   /v1/auth/identity-info · /v1/registration/*
 *
 * ⚠️ EVERYTHING ABOVE IS STAGING. The backend has not stated production's host
 * or settings, and staging's numbers are explicitly test values. Do not assume
 * they carry over.
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
   *
   * ⚠️ ONE ATTEMPT PER CODE. A wrong answer SPENDS the code — there is no
   * second guess at it. The challenge stays alive (keep the same
   * `challenge_token`), but the way forward is a new code, so the screen after a
   * refusal must send them back to messaging the number rather than sit on the
   * code field. Four digits reachable by anyone holding a link is a small enough
   * space that allowing retries would make guessing a strategy; spending the
   * code makes every guess cost a WhatsApp round trip to a handset the guesser
   * does not have, and the owner watches each one arrive.
   *
   * The refusal is `401 UNAUTHENTICATED` — wrong, expired and already-used all
   * answer the same, and so does a locked account. Do not tell them apart.
   */
  privateCode: "/v1/auth/private-code",

  /**
   * ✅ Face check. Runs on EVERY sign-in — step 3 on a first login, and the
   * ONLY step on every later one, so it is what returns COMPLETED there.
   *
   * ✅ REAL as of 2026-09-22: the KYC Worker runs Rekognition liveness and
   * match, and the backend computes the verdict from its numbers. A failure is
   * a real failure. (Staging's thresholds are ~1% for testing, so it will pass
   * almost anything — that is a test setting, not the verifier being a stub.
   * The stub still exists behind `KYC_INTERNAL_SECRET`/`KYC_SHARED_SECRET` being
   * unset; the server says so at startup.)
   *
   * Takes `evidence: { step_token }` — the Worker's single-use proof, never an
   * image. ⚠️ Do NOT call this without one: it answers 401 UNAUTHENTICATED and
   * charges a second attempt on top of the one the failure already cost.
   */
  face: "/v1/auth/face",

  /**
   * ✅ First-login ID enrolment, and the LAST step of a first sign-in — so its
   * response carries the token pair rather than another stage.
   *
   * ⚠️ It used to advance to DEVICE_REQUIRED. With device verification off it
   * answers COMPLETED with `tokens`, which `applyStage` already handles — but
   * anything that assumed "the document step is never the last one" is wrong.
   *
   * ⚠️ THE BASE64 PAYLOAD IS GONE. `{ document_type, front, back }` now answers
   * 422. This takes `evidence: { step_token }`, exactly like `/auth/face`, and
   * `POST /v1/kyc/submit` is what mints it: the Worker sends that route the
   * images and its measurements over a signed channel, the backend decides, and
   * only the proof comes back to the browser. The document is a photograph of a
   * government ID with a face on it, so every argument for keeping the selfie
   * off the auth path applies to it with more force, not less.
   *
   * **3 tries per sign-in** (`KYC_MAX_DOCUMENT_ATTEMPTS`), and each failure also
   * charges the per-sign-in counter. A fourth answers CHALLENGE_INVALID and the
   * person restarts at /link. A failed verdict never reaches this endpoint at
   * all — no step token is minted, so there is nothing to post.
   *
   * There is deliberately no companion `identity-info`. That existed when
   * the protocol expected the administrator to TYPE their ID details as a
   * separate step; OCR removed it, so no second user action was left for a
   * second stage to wait on. See docs/kyc/backend.md, decision 7.
   */
  identityDocument: "/v1/auth/identity-document",

  /**
   * 🚫 DORMANT — device verification is off, so no challenge ever sits at the
   * DEVICE stage and this answers 412 PRECONDITION_FAILED. Kept, with the whole
   * ceremony, because the backend setting flips in one line; a stage-driven
   * client needs no change when it does. Do not build against it, do not delete
   * it.
   *
   * Everything below describes the behaviour when it IS on.
   *
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
   * 🚫 DORMANT for the same reason as `deviceOptions` above — 412 while device
   * verification is off.
   *
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
   * ✅ FIXED as of 2026-09-22 — and authoritative again.
   *
   * It used to rebuild `user` from the access token: `status` was always
   * "ACTIVE", and `locale`, `timezone` and `created_at` came back empty or as Go
   * zero values. Requiring any of them made `getSession()` throw, it answered
   * `null` for everybody, and every protected page redirected to /login — a
   * signed-in administrator could not reach the dashboard at all. That is why
   * almost everything in `wireUserSchema` is optional, and it is why the session
   * cookie exists.
   *
   * Now it returns the account as stored, in the same shape as `tokens.user`.
   * `getSession()` reads this; the cookie is a transport-failure fallback only.
   * See `lib/auth/session.ts` for the exact rule.
   *
   * It also carries `projects` — the managed systems registry. See
   * `meResponseSchema`.
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
    /**
     * Code-specific extras. Two are known:
     *
     *   RATE_LIMITED         `retry_after_seconds` — the same integer the
     *                        `Retry-After` HEADER carries. Both are read
     *                        (header first) in `lib/auth/errors.ts`, because a
     *                        429 raised by an edge or a proxy may carry the
     *                        header and no body at all.
     *   PRECONDITION_FAILED  `stage` — where the challenge ACTUALLY is, when a
     *                        step was sent out of order. A client that lost
     *                        track can route on it instead of restarting.
     *
     * Passthrough rather than a closed shape: it is a grab-bag the backend adds
     * to, and an unrecognised key must not fail the parse of an error we are
     * already in the middle of handling.
     */
    details: z
      .object({
        retry_after_seconds: z.number().int().optional(),
        stage: z.string().optional(),
      })
      .loose()
      .optional(),
    correlation_id: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** Error codes worth handling by name. */
export const ERROR_CODES = {
  /**
   * ⚠️ FOUR DIFFERENT THINGS, and what to do differs. Read WHICH CALL got it —
   * the code alone does not tell you, on purpose.
   *
   *   /auth/link            the link is unknown, revoked, expired, outside its
   *                         address range or country, or the account is
   *                         suspended. One message covers all of them because
   *                         the server gives one. Never guess which tripped.
   *   /auth/private-code    the code was wrong, expired or already used — or
   *                         the account is locked. THE CHALLENGE IS STILL
   *                         ALIVE. Keep the token; send them for a new code.
   *   /auth/face,
   *   /auth/identity-document   no step token outstanding: the Worker's commit
   *                         never passed, the proof was for another sign-in, or
   *                         it expired. THE CHALLENGE IS STILL ALIVE and they
   *                         may re-capture — it just cost an attempt.
   *   authenticated calls,
   *   /auth/refresh         the session has ended — revoked link, or signed out
   *                         elsewhere. Sign out. This is NOT `TOKEN_REUSED`;
   *                         revocation never looks like reuse.
   *
   * So this does NOT mean "restart the sign-in". Only CHALLENGE_INVALID does —
   * see `isChallengeDead` in lib/auth/errors.ts.
   */
  unauthenticated: "UNAUTHENTICATED",
  /** A missing field, or `evidence` that is not an object with ≥1 key. */
  validationFailed: "VALIDATION_FAILED",
  /**
   * Expired, already used, burned by too many failures, or a step sent out of
   * order. Restart at /auth/link — do NOT retry the step.
   */
  challengeInvalid: "CHALLENGE_INVALID",
  /**
   * ⚰️ RETIRED on this flow. A wrong private code — and a locked account —
   * answer UNAUTHENTICATED now. This code was what a locked account used to
   * return, which made the lock detectable; the backend calls that a bug and
   * has fixed it.
   *
   * Kept only so an older deployment answering it still maps to a sentence
   * rather than falling through to a raw message. Do not branch on it in new
   * code.
   */
  invalidCredentials: "INVALID_CREDENTIALS",
  /**
   * Per-caller rate limit, keyed on the caller's network ADDRESS:
   *   POST /v1/auth/link                       10 / minute
   *   every other POST /v1/auth/* and /refresh 60 / minute
   *   any authenticated request (per session) 300 / minute
   *
   * ⚠️ THE CALLER IS THIS WORKER, NOT THE ADMINISTRATOR — until we forward the
   * browser's address. The browser never reaches the backend (AGENTS.md §2), so
   * every request leaves from `canroot` and the address the limiter sees is
   * ours. **Today those budgets are shared by every administrator at once**, and
   * anyone who can load the sign-in page can exhaust the 10/minute on
   * `/auth/link` for everybody.
   *
   * The fix is built backend-side and waiting on us: send `X-Edge-Client-IP`
   * (`CF-Connecting-IP`), `X-Edge-Client-Country` (`CF-IPCountry`) and
   * `X-Edge-Secret`, plus the BROWSER's `User-Agent`. They are trusted only with
   * the secret, so setting them without it gains an attacker nothing. **We do
   * not hold the secret yet** — that is what blocks it.
   *
   * Only one source of 429 reaches us. The WhatsApp per-number limit (5 code
   * requests / 15 min) is enforced by dropping messages, so it never appears as
   * an HTTP response — an administrator who "messaged and got nothing" is the
   * only symptom, and no UI can see it.
   *
   * Never auto-retry. `retryAfterSeconds()` in `lib/auth/errors.ts` reads the
   * delay; show it and let the person decide. A retry loop against a limiter is
   * how somebody stays locked out for as long as their tab is open.
   */
  rateLimited: "RATE_LIMITED",
  /**
   * Step-up: this action needs a fresh device check before it will run.
   *
   * ⚠️ NOT REACHABLE TODAY — the proof it demands is a passkey assertion, and
   * with device verification off no session has one. The backend refuses to
   * start with step-up enabled in that combination.
   *
   * Listed anyway because it is a 401, and a 401 that reaches a generic handler
   * gets a refresh and then a sign-out. If it ever arrives, pressing "Issue
   * link" would sign the administrator out instead of prompting them. Branching
   * on it costs two lines now and saves a bug hunt later. See §2 of
   * `backend docs/frontend-security-changes.md` for the ceremony, which we
   * deliberately have NOT built.
   */
  mfaRequired: "MFA_REQUIRED",
  /**
   * The request was well formed but the server is not in a state to take it —
   * a device endpoint called while device verification is off, or a reassert
   * submitted without asking for options first. Read the message; there is no
   * useful branching below this.
   */
  preconditionFailed: "PRECONDITION_FAILED",
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
  /**
   * WebAuthn ceremony: enrol this device, or prove it.
   *
   * 🚫 Never sent while device verification is off. Kept so the day it comes
   * back is a backend setting and not a frontend release.
   */
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

  /**
   * 🚫 Unreachable while device verification is off — no response names this
   * stage, so nothing routes here. Left in place deliberately: this entry IS
   * the one-line cost of the setting being flipped back on.
   */
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
  /** Arabic name, when the account has one. */
  full_name_ar: z.string().optional(),
  status: z.string(),
  /** The only privilege flag the API exposes. */
  is_root: z.boolean(),

  /**
   * ⚠️ OMITTED on most root accounts. They are created over WhatsApp and
   * usually have no email at all, so an absent `email` is an ordinary account,
   * NOT a broken one. Never gate anything on its presence.
   */
  email: z.string().optional(),

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
  /**
   * Only on `/auth/link`, and only when re-opening picked up a sign-in already
   * in progress — same `challenge_id`, a NEW `challenge_token`, and whatever is
   * left of the original ten minutes (resuming never widens the window).
   *
   * Deliberately not branched on anywhere. Treat every `/auth/link` response the
   * same way — render the stage it names. Resumption is the exception rather
   * than the rule, and it happens only for a caller that looks like the one that
   * made the progress: same link, same IP, same `User-Agent`. That last
   * condition is why forwarding the browser's UA matters (see §1 of the change
   * notes) — with our own UA going out, no refresh mid-flow can ever resume.
   */
  resumed: z.boolean().optional(),
  /**
   * How long a private code lives, in seconds, from the deployment's real
   * setting. Only on `PRIVATE_CODE_REQUIRED`.
   *
   * ⚠️ NEVER HARD-CODE THIS. It was a local constant of 50, the change notes
   * said 500, and both were right — 500 on staging, 50 by default — which is
   * exactly why the backend now sends it. A number baked in here is wrong on
   * some deployment.
   *
   * ⚠️ AND NEVER BUILD A COUNTDOWN FROM IT. The clock starts when the person
   * messages WhatsApp, a moment neither we nor the backend ever observes, so
   * any timer we drew would be counting from the wrong instant. It is for copy
   * — "valid for about eight minutes" — and the instruction to message the
   * number again stays on screen permanently rather than appearing on a timer.
   */
  private_code_ttl_seconds: z.number().int().positive().optional(),
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
 * One managed system — this IS the registry the dashboard lost when
 * `root-backend` was deleted, confirmed by the backend 2026-09-22. For a root
 * administrator `projects` is every registered system, so an empty array means
 * none is registered yet rather than none is visible.
 *
 * ⚠️ NO BASE URL. `lib/api/backend.ts` needs one per system to route project
 * data (regions, currencies, …) to that project's own backend, and nothing here
 * carries it. So this unblocks the /systems LIST and nothing downstream of it.
 * Open with the backend.
 *
 * Only `id` is required: the backend documents the rest as present but
 * `connection_status` and `health_status` are explicitly omitted until a
 * connection exists, and a registry entry that fails to parse would take the
 * whole session read down with it.
 */
export const wireProjectSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  name_ar: z.string().optional(),
  /** e.g. "TRYDOS" — the stable handle, and what a per-system API key keys on. */
  code: z.string().optional(),
  status: z.string().optional(),
  project_type: z.string().optional(),
  connection_status: z.string().optional(),
  health_status: z.string().optional(),
});
export type WireProject = z.infer<typeof wireProjectSchema>;

/** The session read. `user` is the account as stored; `projects` is the registry. */
export const meResponseSchema = z.object({
  user: wireUserSchema,
  projects: z.array(wireProjectSchema).optional(),
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
 * Used ONLY as the flow cookie's fallback ceiling — `challenge_expires_at` from
 * the server is the authoritative deadline, and `cookieLifetime` in
 * `lib/auth/challenge.ts` prefers it.
 */
export const CHALLENGE_MAX_AGE = 10 * 60;

/*
 * ⚰️ `PRIVATE_CODE_TTL` used to live here, hard-coded at 50 seconds.
 *
 * It is gone because it could not be right: 50 is the backend's default and 500
 * is what staging runs, so any constant here is wrong on some deployment. The
 * real value now arrives as `private_code_ttl_seconds` on the
 * PRIVATE_CODE_REQUIRED response — see `stepResponseSchema`.
 *
 * The comment it carried also promised a live countdown, which was never built
 * and must not be: the code's clock starts when the administrator messages
 * WhatsApp, and nobody on either side sees that moment.
 */

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

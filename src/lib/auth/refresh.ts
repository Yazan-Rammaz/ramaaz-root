import {
    apiErrorSchema,
    AUTH_PATHS,
    ERROR_CODES,
    REFRESH_MAX_AGE,
    refreshResponseSchema,
    type AuthTokens,
    type RefreshProof,
} from "./endpoints";

/**
 * Single-flight refresh.
 *
 * ── The race this exists to stop ────────────────────────────────────────────
 * Refresh tokens are single-use and rotate, and replaying a spent one is read
 * as theft: the backend answers TOKEN_REUSED and destroys the WHOLE token
 * family. So two requests exchanging the same token do not merely lose one
 * refresh — the second kills the session and the admin is thrown out.
 *
 * That is easy to hit: two tabs left idle past the 15-minute access-token life,
 * then both touched. Each sends the same refresh cookie, and one of them loses.
 *
 * ── How it is stopped ───────────────────────────────────────────────────────
 * Two module-level maps, which survive between requests because a Worker
 * isolate is reused:
 *
 *   inflight  concurrent requests carrying the same token await ONE exchange
 *             instead of each starting their own.
 *   recent    the result is kept briefly afterwards, so a request that arrives
 *             just after the winner finished — still holding the old cookie,
 *             because its response had not come back yet — is handed the new
 *             pair rather than replaying a spent token.
 *
 * `inflight` alone would not be enough: the losing tab's request usually
 * arrives slightly AFTER the winner completed, not during it.
 *
 * ── What it does not cover ──────────────────────────────────────────────────
 * State is per isolate. Requests served by different isolates or colos cannot
 * see each other, and that residual case still races. Closing it completely
 * needs shared strongly-consistent storage — a Durable Object — which OpenNext
 * makes awkward here because it generates the worker entry that would have to
 * export it. This covers the realistic case (one browser, several tabs, one
 * colo) with no infrastructure at all, and behaves exactly as before otherwise.
 */

/**
 * What an exchange decided — and specifically, whether the caller may delete
 * the cookies.
 *
 * ── Why this is not just `AuthTokens | null` ────────────────────────────────
 * It used to be, and every non-2xx became null, and middleware reads null as
 * "the session is over" and clears both cookies. That was right while the only
 * way to fail was a spent or expired token. It stopped being right when the
 * backend added a rate limit to `/v1/auth/refresh`:
 *
 *   429 → null → cookies deleted → the administrator is signed out, holding a
 *   refresh token that was perfectly valid.
 *
 * And the limit is keyed on the caller's ADDRESS, which for us is one Worker
 * serving every administrator — so the 60/minute budget is shared company-wide
 * and this is reachable, not theoretical. A refusal to serve us right now says
 * nothing about whether the session is alive.
 */
export type RefreshOutcome =
    /** A new pair. Set both cookies. */
    | { status: 'refreshed'; tokens: AuthTokens }
    /**
     * The session is over — expired, spent, revoked, reuse detected, or a
     * transport failure that may have rotated the token unseen. Clear cookies.
     * `message` is the backend's own sentence when it gave one (e.g. "Sign in
     * again to set your PIN."), for the screen that explains the sign-out.
     */
    | { status: 'dead'; message?: string }
    /**
     * Rate limited. KEEP the cookies and do nothing else — no retry, no timer.
     * The next request the administrator makes will try again, which is the
     * person deciding rather than a loop deciding for them.
     */
    | { status: 'deferred'; retryAfterSeconds?: number }
    /**
     * `401 PASS_CODE_REQUIRED` — the session is ALIVE and wants the PIN (or
     * the device, when `deviceAvailable`). KEEP the cookies: the token is
     * unspent and the retry carries the proof with the same one. Treating this
     * as `dead` is what would sign every administrator out the moment their
     * access token expired with `ROOT_REQUIRE_PASS_CODE` on.
     */
    | { status: 'locked'; deviceAvailable: boolean }
    /**
     * `401 INVALID_CREDENTIALS` (wrong PIN, or a device that did not verify) or
     * `VALIDATION_FAILED` on a proof — only ever the answer to a refresh that
     * CARRIED one. Unspent token, keep the cookies, let them try again. Whether
     * another try can succeed (the PIN lockout) is the backend's call, not ours.
     */
    | { status: 'rejected' };

/** How long a completed exchange stays reusable. Far inside the ~900s access token life. */
const RECENT_TTL_MS = 60_000;

/** Bound the map — a long-lived isolate would otherwise accumulate entries. */
const MAX_RECENT = 50;

const inflight = new Map<string, Promise<RefreshOutcome>>();
const recent = new Map<string, { at: number; tokens: AuthTokens }>();

function readRecent(token: string): AuthTokens | null {
    const hit = recent.get(token);
    if (!hit) return null;
    if (Date.now() - hit.at > RECENT_TTL_MS) {
        recent.delete(token);
        return null;
    }
    return hit.tokens;
}

function writeRecent(token: string, tokens: AuthTokens): void {
    // Cheap eviction: drop the oldest insertion (Map preserves insertion order).
    if (recent.size >= MAX_RECENT) {
        const oldest = recent.keys().next();
        if (!oldest.done) recent.delete(oldest.value);
    }
    recent.set(token, { at: Date.now(), tokens });
}

async function exchange(
    base: string,
    refreshToken: string,
    caller: Record<string, string>,
    proof: RefreshProof | undefined,
): Promise<RefreshOutcome> {
    try {
        // The token goes in the BODY, not an Authorization header.
        const res = await fetch(`${base}${AUTH_PATHS.refresh}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                // Who is really refreshing — /auth/refresh sits in the same
                // 60/minute per-address bucket as the sign-in steps, so without
                // these every administrator shares one. See lib/api/edge.ts.
                ...caller,
            },
            body: JSON.stringify({ refresh_token: refreshToken, ...proof }),
        });

        // Rate limited — say nothing about the session. See RefreshOutcome.
        // Confirmed (change notes §8): the limiter refuses before the code that
        // rotates the token, so a 429 did NOT spend it and keeping it is right.
        if (res.status === 429) {
            const header = Number(res.headers.get('Retry-After'));
            return {
                status: 'deferred',
                retryAfterSeconds: Number.isInteger(header) && header > 0 ? header : undefined,
            };
        }

        if (!res.ok) {
            // ⚠️ Read the CODE before deciding the session is over. Two 401s
            // here leave the token unspent, and clearing the cookies on either
            // would sign out somebody whose session is perfectly alive.
            const error = apiErrorSchema.safeParse(await res.json().catch(() => null));
            const code = error.success ? error.data.error.code : undefined;

            if (code === ERROR_CODES.passCodeRequired) {
                return {
                    status: 'locked',
                    deviceAvailable: error.success && error.data.error.details?.device_available === true,
                };
            }
            // A refused PROOF — wrong PIN, unverified device, or a malformed
            // one. Only possible when one was sent; without a proof these codes
            // are not expected, and falling through to `dead` is the safe read.
            if (
                proof &&
                (code === ERROR_CODES.invalidCredentials || code === ERROR_CODES.validationFailed)
            ) {
                return { status: 'rejected' };
            }
            return {
                status: 'dead',
                message: error.success ? error.data.error.message : undefined,
            };
        }

        // Tokens come back at the TOP level here, unlike the sign-in steps
        // which nest them under `tokens`. Parsed rather than cast: a silent
        // shape change would otherwise write `undefined` into the auth cookies
        // and log everyone out with no clue why.
        const parsed = refreshResponseSchema.safeParse(await res.json());
        if (!parsed.success) return { status: 'dead' };

        return {
            status: 'refreshed',
            tokens: {
                accessToken: parsed.data.access_token,
                refreshToken: parsed.data.refresh_token,
                accessMaxAge: parsed.data.expires_in,
                refreshMaxAge: REFRESH_MAX_AGE,
            },
        };
    } catch {
        // Transport failure — `dead`, and the backend says so explicitly
        // (change notes §8): the request may have reached them and rotated the
        // token without us seeing the answer, so retrying with the same one
        // risks TOKEN_REUSED, which revokes every session on the account.
        return { status: 'dead' };
    }
}

/**
 * Exchange `refreshToken` for a fresh pair, at most once per token.
 *
 * Only `dead` licenses the caller to clear the auth cookies — a spent token
 * retried forever can never recover. `deferred`, `locked` and `rejected` must
 * leave them exactly as they are; see RefreshOutcome for why.
 */
export async function refreshTokens(
    base: string,
    refreshToken: string,
    /**
     * Caller headers from `lib/api/edge.ts`. Passed in rather than read here:
     * this runs inside edge middleware, which has a `NextRequest` and cannot
     * use `next/headers`.
     *
     * They are NOT part of the single-flight key — the token identifies the
     * exchange, and two requests for the same token must share one result
     * whatever address they arrived from.
     */
    caller: Record<string, string> = {},
    /**
     * The PIN (or device) the person just gave — only from the unlock action.
     * Middleware never has one, so its refreshes answer `locked` while the
     * setting is on.
     */
    proof?: RefreshProof,
): Promise<RefreshOutcome> {
    const alreadyDone = readRecent(refreshToken);
    if (alreadyDone) return { status: 'refreshed', tokens: alreadyDone };

    const pending = inflight.get(refreshToken);
    if (pending) {
        const shared = await pending;
        // Without a proof, whatever that exchange decided is the answer for
        // this request too. A `rejected` there was somebody else's wrong PIN;
        // for a request that sent none, the honest reading is still "locked".
        if (!proof) return shared.status === 'rejected' ? { status: 'locked', deviceAvailable: false } : shared;
        // WITH a proof, only a success can be shared: a PIN-less exchange that
        // answered `locked` says nothing about this PIN. It has finished, so
        // starting our own now is sequential, not concurrent.
        if (shared.status === 'refreshed') return shared;
        const nowDone = readRecent(refreshToken);
        if (nowDone) return { status: 'refreshed', tokens: nowDone };
    }

    const run = exchange(base, refreshToken, caller, proof);
    inflight.set(refreshToken, run);

    try {
        const outcome = await run;
        // Only successes are remembered. A failure must stay a failure, or a
        // dead session would look alive for a minute — and a `deferred` one
        // must be retried on the next request rather than answered from cache.
        // A wrong PIN in particular must never be answered from cache.
        if (outcome.status === 'refreshed') writeRecent(refreshToken, outcome.tokens);
        return outcome;
    } finally {
        // Only our own entry: a proof-carrying run can start after a shared
        // one finished, and must not delete a newer run's promise.
        if (inflight.get(refreshToken) === run) inflight.delete(refreshToken);
    }
}

/**
 * The refresh token to use for a call that must not overlap a rotation — the
 * device options call (`AUTH_PATHS.refreshDeviceOptions`), which spends nothing
 * but runs every check a refresh does.
 *
 * If an exchange of `refreshToken` is in flight in this isolate, wait for it:
 * asking with the old token while it rotates is exactly the overlap the backend
 * warns about. A success hands back its replacement (which the caller must
 * also store); anything else, the token as it was.
 */
export async function settledRefreshToken(
    refreshToken: string,
): Promise<{ token: string; rotated?: AuthTokens }> {
    const pending = inflight.get(refreshToken);
    if (pending) await pending;
    const rotated = readRecent(refreshToken);
    return rotated ? { token: rotated.refreshToken, rotated } : { token: refreshToken };
}

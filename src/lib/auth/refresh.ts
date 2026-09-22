import { AUTH_PATHS, REFRESH_MAX_AGE, refreshResponseSchema, type AuthTokens } from "./endpoints";

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
    /** The session is over — expired, spent, or reuse detected. Clear cookies. */
    | { status: 'dead' }
    /**
     * Rate limited. KEEP the cookies and do nothing else — no retry, no timer.
     * The next request the administrator makes will try again, which is the
     * person deciding rather than a loop deciding for them.
     */
    | { status: 'deferred'; retryAfterSeconds?: number };

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
            body: JSON.stringify({ refresh_token: refreshToken }),
        });

        // Rate limited — say nothing about the session. See RefreshOutcome.
        //
        // ⚠️ OPEN QUESTION with the backend: is the token SPENT when a refresh
        // is rejected with 429? If it is, this token is already dead and we are
        // keeping a cookie that can never work; if it is not, clearing it would
        // have thrown out a live session. Keeping it is the recoverable
        // mistake of the two — a dead token still answers 401 on the next
        // attempt, which lands in `dead` below and clears properly.
        if (res.status === 429) {
            const header = Number(res.headers.get('Retry-After'));
            return {
                status: 'deferred',
                retryAfterSeconds: Number.isInteger(header) && header > 0 ? header : undefined,
            };
        }

        if (!res.ok) return { status: 'dead' };

        // Tokens come back at the TOP level here, unlike /registration/pass-code
        // which nests them under `tokens`. Parsed rather than cast: a silent
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
        // Transport failure — deliberately still 'dead', which is what it has
        // always been. It is arguably as transient as a 429, but nothing has
        // been observed to make that call, and turning a real network partition
        // into "keep retrying forever" is its own failure mode. Left as a known
        // question rather than changed on a guess.
        return { status: 'dead' };
    }
}

/**
 * Exchange `refreshToken` for a fresh pair, at most once per token.
 *
 * Only `dead` licenses the caller to clear the auth cookies — a spent token
 * retried forever can never recover. `deferred` must leave them exactly as they
 * are; see RefreshOutcome for why that distinction exists.
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
): Promise<RefreshOutcome> {
    const alreadyDone = readRecent(refreshToken);
    if (alreadyDone) return { status: 'refreshed', tokens: alreadyDone };

    const pending = inflight.get(refreshToken);
    if (pending) return pending;

    const run = exchange(base, refreshToken, caller);
    inflight.set(refreshToken, run);

    try {
        const outcome = await run;
        // Only successes are remembered. A failure must stay a failure, or a
        // dead session would look alive for a minute — and a `deferred` one
        // must be retried on the next request rather than answered from cache.
        if (outcome.status === 'refreshed') writeRecent(refreshToken, outcome.tokens);
        return outcome;
    } finally {
        inflight.delete(refreshToken);
    }
}

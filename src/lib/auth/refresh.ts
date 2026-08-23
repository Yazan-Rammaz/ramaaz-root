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

/** How long a completed exchange stays reusable. Far inside the ~900s access token life. */
const RECENT_TTL_MS = 60_000;

/** Bound the map — a long-lived isolate would otherwise accumulate entries. */
const MAX_RECENT = 50;

const inflight = new Map<string, Promise<AuthTokens | null>>();
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

async function exchange(base: string, refreshToken: string): Promise<AuthTokens | null> {
    try {
        // The token goes in the BODY, not an Authorization header.
        const res = await fetch(`${base}${AUTH_PATHS.refresh}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) return null;

        // Tokens come back at the TOP level here, unlike /registration/pass-code
        // which nests them under `tokens`. Parsed rather than cast: a silent
        // shape change would otherwise write `undefined` into the auth cookies
        // and log everyone out with no clue why.
        const parsed = refreshResponseSchema.safeParse(await res.json());
        if (!parsed.success) return null;

        return {
            accessToken: parsed.data.access_token,
            refreshToken: parsed.data.refresh_token,
            accessMaxAge: parsed.data.expires_in,
            refreshMaxAge: REFRESH_MAX_AGE,
        };
    } catch {
        return null;
    }
}

/**
 * Exchange `refreshToken` for a fresh pair, at most once per token.
 *
 * Returns null when the refresh genuinely failed — the caller should then clear
 * the auth cookies, because a spent token retried forever can never recover.
 */
export async function refreshTokens(
    base: string,
    refreshToken: string,
): Promise<AuthTokens | null> {
    const alreadyDone = readRecent(refreshToken);
    if (alreadyDone) return alreadyDone;

    const pending = inflight.get(refreshToken);
    if (pending) return pending;

    const run = exchange(base, refreshToken);
    inflight.set(refreshToken, run);

    try {
        const tokens = await run;
        // Only successes are remembered. A failure must stay a failure, or a
        // dead session would look alive for a minute.
        if (tokens) writeRecent(refreshToken, tokens);
        return tokens;
    } finally {
        inflight.delete(refreshToken);
    }
}

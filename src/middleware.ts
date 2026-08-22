import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, matchLocale } from '@/lib/i18n/config';
import {
    AUTH_PATHS,
    REFRESH_MAX_AGE,
    refreshResponseSchema,
    type AuthTokens,
} from '@/lib/auth/endpoints';

/**
 *
 *  1. SECURITY HEADERS — strict CSP (per-request nonce), HSTS, framing/MIME
 *     hardening. `connect-src 'self'` is what forbids the browser from talking
 *     to NestJS directly: all API traffic must go through our BFF.
 *
 *  2. SILENT TOKEN REFRESH — if the short-lived access cookie is gone but a
 *     refresh cookie remains, mint a new pair from NestJS and set them on the
 *     response so the downstream render is authenticated. The authoritative
 *     auth gate is still `requireSession()` in the protected layout.
 */

const ACCESS = 'rdb_at';
const REFRESH = 'rdb_rt';

// Edge runtime may not expose a global `process`; read it defensively.
const globalEnv =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const isProdEnv = process.env.NODE_ENV === 'production' || globalEnv.NODE_ENV === 'production';

function buildCsp(nonce: string) {
    const dev = !isProdEnv;
    // React/Next dev mode uses eval() for Fast Refresh & callstack rebuilding,
    // and a websocket for HMR. Both are dev-only; production stays strict.
    const scriptSrc = dev
        ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
        : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
    const connectSrc = dev ? `connect-src 'self' ws:` : `connect-src 'self'`;
    const directives = [
        `default-src 'self'`,
        scriptSrc,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `font-src 'self'`,
        connectSrc,
        `frame-ancestors 'none'`,
        `base-uri 'self'`,
        `form-action 'self'`,
        `object-src 'none'`,
        `upgrade-insecure-requests`,
    ];
    return directives.join('; ');
}

function applySecurityHeaders(res: NextResponse, nonce: string) {
    res.headers.set('Content-Security-Policy', buildCsp(nonce));
    res.headers.set('x-nonce', nonce);
    res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('X-Frame-Options', 'DENY');
    res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.headers.set(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
    return res;
}

async function tryRefresh(req: NextRequest) {
    const refreshToken = req.cookies.get(REFRESH)?.value;
    if (!refreshToken) return null;

    // Unset until the remote backend is wired — silently skip the refresh
    // rather than fetch a broken URL on every request.
    const base = process.env.NEST_API_URL || globalEnv.NEST_API_URL;
    if (!base) return null;

    try {
        // The refresh token goes in the BODY, not an Authorization header.
        //
        // ⚠️ It is single-use and rotates. Replaying a spent one answers
        // TOKEN_REUSED and the backend ends the entire session — it treats a
        // replay as theft. So: never retry this call with the same token, and
        // on any failure fall through to a normal sign-in rather than trying
        // again.
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
        } satisfies AuthTokens;
    } catch {
        return null;
    }
}

export async function middleware(req: NextRequest) {
    const nonce = crypto.randomUUID().replace(/-/g, '');

    // Forward the nonce to the app so the document can tag inline scripts.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-nonce', nonce);

    // First-visit language auto-detection: if no language cookie yet, pick the
    // best match from Accept-Language (falls back to the default locale). We patch
    // the FORWARDED request cookie header before NextResponse.next reads it, so
    // next-intl resolves the right messages on this very render; the matching
    // response cookie (set below) makes it stick. Afterwards the cookie is
    // authoritative and the <LocaleSwitcher> overwrites it.
    const detectedLocale = req.cookies.has(LOCALE_COOKIE)
        ? null
        : matchLocale(req.headers.get('accept-language'));
    if (detectedLocale) {
        const cookieHeader = requestHeaders.get('cookie');
        requestHeaders.set(
            'cookie',
            `${cookieHeader ? `${cookieHeader}; ` : ''}${LOCALE_COOKIE}=${detectedLocale}`,
        );
    }

    const res = NextResponse.next({ request: { headers: requestHeaders } });

    if (detectedLocale) {
        res.cookies.set(LOCALE_COOKIE, detectedLocale, {
            path: '/',
            maxAge: LOCALE_COOKIE_MAX_AGE,
            sameSite: 'lax',
        });
    }

    // Silent refresh when the access cookie has expired but refresh is still good.
    //
    // ⚠️ Refresh tokens are single-use and rotate, and the backend treats a
    // replay as theft: it answers TOKEN_REUSED and kills the ENTIRE token
    // family — verified on staging, where replaying a spent token also
    // invalidated the legitimately rotated one that replaced it. So two
    // concurrent refreshes do not merely lose a request, they log the admin out.
    //
    // Prefetches are the worst offender: Next fires a burst of them in parallel
    // on hover/viewport, so an expired access cookie could trigger several
    // refreshes at once. Their responses are discarded anyway, so skipping them
    // removes the main source of concurrency at no cost — the real navigation
    // that follows refreshes normally.
    //
    // NOT a complete fix: two genuine navigations (two tabs) can still race.
    // Closing that needs single-flight coordination in shared storage (KV or a
    // Durable Object), which is a deliberate piece of infrastructure rather
    // than something to bolt on here.
    const isPrefetch =
        req.headers.get('next-router-prefetch') === '1' ||
        req.headers.get('purpose') === 'prefetch' ||
        req.headers.get('x-purpose') === 'prefetch';

    const hasAccess = req.cookies.has(ACCESS);
    const hasRefresh = req.cookies.has(REFRESH);
    if (!hasAccess && hasRefresh && !isPrefetch) {
        const refreshed = await tryRefresh(req);
        if (refreshed) {
            const secure = isProdEnv;
            const opts = {
                httpOnly: true,
                secure,
                sameSite: 'lax' as const,
                path: '/',
            };
            res.cookies.set(ACCESS, refreshed.accessToken, {
                ...opts,
                maxAge: refreshed.accessMaxAge,
            });
            res.cookies.set(REFRESH, refreshed.refreshToken, {
                ...opts,
                maxAge: refreshed.refreshMaxAge,
            });
        }
    }

    return applySecurityHeaders(res, nonce);
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.\\w+$).*)'],
};

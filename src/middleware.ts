import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, matchLocale } from '@/lib/i18n/config';
import { refreshTokens } from '@/lib/auth/refresh';

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

const ACCESS = 'root_at';
const REFRESH = 'root_rt';

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

    // Single-flight: refresh tokens rotate and are single-use, and replaying a
    // spent one destroys the whole session. Two tabs idle past the access
    // token's 15 minutes will both arrive holding the same cookie, so the
    // exchange is deduplicated per token — see lib/auth/refresh.ts.
    return refreshTokens(base, refreshToken);
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
    // Two defences:
    //   - prefetches never refresh. Next fires bursts of them on hover and
    //     viewport entry, and their responses are discarded anyway, so skipping
    //     them removes the largest source of concurrency at no cost.
    //   - the exchange itself is single-flight per token (lib/auth/refresh.ts),
    //     which covers what remains: two tabs, both idle past the access
    //     token's 15 minutes, both arriving with the same refresh cookie.
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
        } else {
            // The refresh failed: the token is expired, already spent, or the
            // backend ended the session because a spent one was replayed.
            //
            // Clear it. Leaving a dead refresh token in the browser is worse
            // than having none — it survives for REFRESH_MAX_AGE, so EVERY
            // later request retries a refresh that cannot succeed, and each
            // retry trips reuse detection again. The visible symptom is a
            // browser that still holds root_rt yet is bounced to /login on
            // every page, with no way out but clearing cookies by hand.
            //
            // root_pc is deliberately kept: the private code is not a session,
            // and holding it lets the admin unlock with just their passcode
            // instead of retyping it.
            res.cookies.delete(ACCESS);
            res.cookies.delete(REFRESH);
        }
    }

    return applySecurityHeaders(res, nonce);
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.\\w+$).*)'],
};

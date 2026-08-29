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

/**
 * May this response be framed by our own origin?
 *
 * True for the design gallery in development and nothing else. The gallery
 * frames each screen so it gets a viewport of exactly the XD canvas width —
 * which is what makes one XD pixel equal one rendered pixel — and `DENY` blocks
 * that even same-origin (`SAMEORIGIN` is the value that does not).
 *
 * Scoped twice over: development, AND a path that 404s in production anyway.
 * Every other response keeps `DENY` / `frame-ancestors 'none'` byte for byte.
 */
function isFramable(req: NextRequest) {
    return !isProdEnv && req.nextUrl.pathname.startsWith('/design');
}

function buildCsp(nonce: string, framable: boolean) {
    const dev = !isProdEnv;
    // React/Next dev mode uses eval() for Fast Refresh & callstack rebuilding,
    // and a websocket for HMR. Both are dev-only; production stays strict.
    // `wasm-unsafe-eval` is REQUIRED in production, not an optimisation.
    //
    // The face gate runs MediaPipe's face landmarker and ID capture runs
    // OpenCV — both WebAssembly. Instantiating WASM is blocked by a CSP that
    // does not allow it, and the failure is silent: the module never resolves,
    // `useFaceGate` sits at `model_loading` forever, no frame is ever released,
    // and the screen shows a live camera that simply never captures.
    //
    // It works in dev only by accident: `unsafe-eval` is there for Fast
    // Refresh and happens to permit WASM too. So this is exactly the class of
    // bug that cannot reproduce locally.
    //
    // `wasm-unsafe-eval` is narrow on purpose — it permits WebAssembly
    // compilation and nothing else. It is NOT `unsafe-eval`, which would also
    // re-open `eval()` and `new Function()` to any injected string.
    const scriptSrc = dev
        ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' 'wasm-unsafe-eval'`
        : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`;
    const connectSrc = dev ? `connect-src 'self' ws:` : `connect-src 'self'`;
    const directives = [
        `default-src 'self'`,
        scriptSrc,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `font-src 'self'`,
        // Web Workers, and the ONLY reason this directive exists.
        //
        // Without it `worker-src` falls back to `child-src` and then to
        // `default-src 'self'`, which allows the document scanner's own bundled
        // worker but blocks the `blob:` worker MediaPipe creates for the face
        // landmarker. `'self'` covers ours; `blob:` covers theirs.
        //
        // This is narrow: it governs worker scripts only, and says nothing
        // about what may execute in the page. Note that `blob:` in `script-src`
        // would NOT have covered it — worker creation is a separate directive,
        // and `strict-dynamic` makes script-src ignore scheme sources anyway.
        `worker-src 'self' blob:`,
        connectSrc,
        framable ? `frame-ancestors 'self'` : `frame-ancestors 'none'`,
        `base-uri 'self'`,
        `form-action 'self'`,
        `object-src 'none'`,
    ];

    // `upgrade-insecure-requests` is PRODUCTION ONLY, and the reason is
    // `npm run dev:mobile`.
    //
    // It tells the browser to rewrite every http:// request on the page to
    // https://. Over localhost that is harmless — browsers exempt it. Over a
    // LAN origin like http://192.168.1.100:3002, which is the whole point of
    // dev:mobile, it is fatal: the phone upgrades every script, stylesheet and
    // HMR request to https on a port serving no TLS, and the page arrives
    // stripped of everything. The symptom is an unstyled or blank screen with
    // console errors naming URLs nobody wrote, which reads like a broken build
    // rather than a header.
    //
    // Production is unaffected: it is served over https, where this directive
    // is a genuine defence and upgrading changes nothing that was not already
    // secure.
    if (!dev) directives.push(`upgrade-insecure-requests`);

    return directives.join('; ');
}

function applySecurityHeaders(res: NextResponse, nonce: string, framable = false) {
    res.headers.set('Content-Security-Policy', buildCsp(nonce, framable));
    res.headers.set('x-nonce', nonce);
    // HSTS is PRODUCTION ONLY, for the same reason as
    // `upgrade-insecure-requests` above — and this one leaves a mark.
    //
    // A browser ignores HSTS over plain http, so it was inert while dev was
    // http. `npm run dev:mobile` serves dev over https, at which point the
    // header is honoured and the origin is pinned to https for two years,
    // `includeSubDomains` and all. Going back to `npm run dev` afterwards then
    // fails with a redirect to https on a port serving none — and clearing it
    // means a trip through chrome://net-internals/#hsts, which nobody guesses
    // from the symptom.
    if (isProdEnv) {
        res.headers.set(
            'Strict-Transport-Security',
            'max-age=63072000; includeSubDomains; preload',
        );
    }
    res.headers.set('X-Content-Type-Options', 'nosniff');
    // Paired with `frame-ancestors` above — older browsers read only this one,
    // so relaxing one without the other leaves the frame blocked in whichever
    // browser happens to trust the other header.
    res.headers.set('X-Frame-Options', framable ? 'SAMEORIGIN' : 'DENY');
    res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.headers.set(
        'Permissions-Policy',
        // camera=(self): the identity flow captures a live face, so denying it
        // outright — which is what camera=() does — blocks our OWN document.
        // It surfaces as "Permissions policy violation: camera is not allowed
        // in this document", from our own header rather than the browser's
        // permission prompt. (self) still refuses every embedded third party.
        'camera=(self), microphone=(), geolocation=(), browsing-topics=()',
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
            // Nothing else is kept alongside them: this app persists no
            // identity between sign-ins. The access link is the identity, and
            // the trusted device is stored backend-side.
            res.cookies.delete(ACCESS);
            res.cookies.delete(REFRESH);
        }
    }

    return applySecurityHeaders(res, nonce, isFramable(req));
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.\\w+$).*)'],
};

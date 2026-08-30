import { NextResponse, type NextRequest } from 'next/server';
import { cfEnv } from '@/lib/cf-env';

/**
 * `/design/unlock?key=…` — trade the key for a cookie, once per device.
 *
 * ── Why a route handler ─────────────────────────────────────────────────────
 * Two reasons, and both are load-bearing. A layout may not write cookies, so
 * the check in `layout.tsx` can only read one — something has to set it. And a
 * route handler does not run inside layouts, so this file is reachable while
 * every page under /design is still 404ing.
 *
 * ── Why a cookie rather than a key on every URL ─────────────────────────────
 * The gallery frames its own screens and links to `/design/<slug>` all over the
 * place; threading a query parameter through every one of them would be
 * fragile, and would leave the key in every address bar, history entry and
 * referrer. One exchange, then a normal browsing session.
 *
 * Scoped to `/design`, so it is never sent with a request to anything else.
 */
export async function GET(req: NextRequest) {
    // cfEnv — see the note in ../layout.tsx.
    const expected = cfEnv('DESIGN_GALLERY_KEY');
    const presented = req.nextUrl.searchParams.get('key');

    // Not configured, or wrong key: 404, the same answer every other /design
    // path gives. Anything else would confirm that a gallery is here to unlock.
    if (!expected || presented !== expected) {
        return new NextResponse(null, { status: 404 });
    }

    const res = NextResponse.redirect(new URL('/design', req.nextUrl.origin));
    res.cookies.set('design_gallery', expected, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        // Never leaves /design — the rest of the app has no business seeing it.
        path: '/design',
        maxAge: 60 * 60 * 24 * 30,
    });
    return res;
}

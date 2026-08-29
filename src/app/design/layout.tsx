import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

/**
 * The design gallery — a tool for checking screens against XD.
 *
 * ── Who can reach it ────────────────────────────────────────────────────────
 * Development: always. Production: only with a key, and only if one has been
 * configured at all.
 *
 * It used to 404 in production unconditionally. That was the safe default while
 * the gallery was a local tool, but the screens it renders are drawn for a
 * phone and the only honest place to check a phone layout is a phone — over the
 * real deployment, not a LAN address with a self-signed certificate.
 *
 * ── Why it is not simply switched on ────────────────────────────────────────
 * This gallery renders every screen of a BANKING ADMINISTRATION CONSOLE with
 * the session gate and the sign-in challenge stepped over, and fixture data
 * standing in for a signed-in administrator. Nothing real leaks — the data is
 * invented and no session is minted, so it grants access to nothing — but it
 * does hand a stranger the complete shape of the console: every screen, every
 * step of the sign-in, and the exact wording of both. That is reconnaissance
 * material for talking someone through a fake version of this flow, and it is
 * not something to publish on a guessable path.
 *
 * So: `DESIGN_GALLERY_KEY` must be set as a Cloudflare **secret** (not a
 * `vars` entry — a `vars` entry of the same name would shadow the secret, and
 * would also commit the value to the repo), and the browser must present it
 * once at `/design/unlock?key=…`, which exchanges it for a cookie.
 *
 * Unset key ⇒ every /design route 404s in production, exactly as before. That
 * is the default, and turning the gallery off again is deleting the secret.
 */
export default async function DesignLayout({ children }: { children: ReactNode }) {
    if (process.env.NODE_ENV === 'development') return <>{children}</>;

    const key = process.env.DESIGN_GALLERY_KEY;
    // Not configured — the gallery does not exist here.
    if (!key) notFound();

    const presented = (await cookies()).get('design_gallery')?.value;
    // `notFound()`, not a 401: a 401 confirms there is something here to
    // unlock. A 404 says nothing at all, which is the same thing /no-access
    // does for a bad sign-in link and for the same reason.
    if (presented !== key) notFound();

    return <>{children}</>;
}

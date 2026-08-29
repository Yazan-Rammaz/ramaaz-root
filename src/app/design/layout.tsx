import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

/**
 * The design gallery — a DEVELOPMENT-ONLY tool for checking screens against XD.
 *
 * ── It cannot ship ──────────────────────────────────────────────────────────
 * Every route under /design 404s unless NODE_ENV is development. That is the
 * whole gate, and it is here rather than in each page so a new entry cannot
 * forget it. It matters: these routes render screens that are otherwise behind
 * the session gate and the challenge, with fixture data standing in for a
 * signed-in admin — reachable in production, that is a preview of the console
 * for anyone who guesses the path.
 *
 * ── Why a layout at all ─────────────────────────────────────────────────────
 * To sit OUTSIDE both route groups. `(dashboard)` runs `requireSession()` and
 * `(auth)` paints the brand mark; the gallery wants neither imposed on it, and
 * the screens that want them get them from the shells in `screens.tsx` instead.
 */
export default async function DesignLayout({ children }: { children: ReactNode }) {
    if (process.env.NODE_ENV !== 'development') notFound();
    return <>{children}</>;
}

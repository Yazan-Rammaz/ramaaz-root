import type { ReactNode } from 'react';
import { requireSession } from '@/lib/auth/session';
import { AddActionProvider } from '@/features/shell/add-action';
import { Sidebar } from '@/features/shell/components/Sidebar';
import { Navbar } from '@/features/shell/components/Navbar';
import { PasscodeLock } from '@/features/passcode/components/PasscodeLock';
import { readDeviceHint, readPinLength } from '@/lib/auth/cookies';
import { cfEnv } from '@/lib/cf-env';

/**
 * The app shell for the whole protected area: fixed left rail + top navbar, with
 * pages rendering in the fluid content region. Built as flex (rail = fixed
 * scaled width, content fills the rest) so it fits every canvas with NO x/y
 * scroll — the shape is held by the scaling engine, not a fixed 1366×1024 box.
 *
 * `requireSession()` is the authoritative auth gate (backend `/v1/me`).
 *
 * ── The lock is back, and it is a passcode again ────────────────────────────
 * <PasscodeLock> covers the shell on every fresh page load, after five minutes
 * idle, and whenever the navbar's lock control is pressed. A refresh landing on
 * the passcode screen is the point, not a side effect: arriving here
 * authenticated proves the browser holds a session, not that the person in
 * front of it is the administrator.
 *
 * It renders BESIDE the shell rather than around it, because the glass has to
 * have something to be over — `.lock-glass` filters the real backdrop.
 *
 * ⚠️ It is a UX lock over a live session — locking must never sign anyone out —
 * but the PIN it asks for is the account's, checked by the backend. See
 * `features/passcode/components/PasscodeLock.tsx`.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
    const session = await requireSession();
    // The PIN's length, as the sign-in step reported it. Undefined falls back
    // to the gate's default.
    const pinLength = await readPinLength();
    const deviceBound = await readDeviceHint();

    return (
        <AddActionProvider>
            {/* The name is display only — the gate says WHO is being asked, and the
          session the gate sits on is the one already loaded above. */}
            <PasscodeLock
                name={session.name}
                length={pinLength}
                deviceBound={deviceBound}
                rpId={cfEnv('WEBAUTHN_RP_ID')}
            />
            <div className="flex h-full w-full overflow-hidden">
                <Sidebar />
                <div className="flex min-w-0 flex-1 flex-col">
                    <Navbar />
                    {/* Page content opens here. Long pages scroll INSIDE this region only.
              scrollbar-gutter reserves the scrollbar's width up front so a page
              crossing the scroll threshold (e.g. AI content revealing) doesn't
              shift everything horizontally when the bar appears. */}
                    <main className="thin-scroll relative min-h-0 flex-1 overflow-auto">
                        {children}
                    </main>
                </div>
            </div>
        </AddActionProvider>
    );
}

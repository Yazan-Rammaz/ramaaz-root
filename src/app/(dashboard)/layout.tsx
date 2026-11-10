import type { ReactNode } from 'react';
import { requireSession } from '@/lib/auth/session';
import { AddActionProvider } from '@/features/shell/add-action';
import { Shell } from '@/features/shell/components/Shell';
import { PasscodeLock } from '@/features/passcode/components/PasscodeLock';
import { readDeviceHint, readEnrolHint, readPinLength } from '@/lib/auth/cookies';
import { cfEnv } from '@/lib/cf-env';
import { getSelectedSystem } from '@/lib/api/backend';

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
    const enrolAvailable = await readEnrolHint();
    // The selected system decides what the shell offers: nothing selected →
    // only the systems list and search; selected → its sections unfold and the
    // rail shows its code. Selecting re-renders this layout (`selectSystem`
    // revalidates it), which is what plays the unfold.
    //
    // A failed registry read is shown as "nothing selected" rather than taking
    // the whole shell down: the shell only decorates with this, and /systems
    // reads the same registry and surfaces the real error there.
    const system = await getSelectedSystem().catch(() => null);

    return (
        <AddActionProvider>
            {/* The name is display only — the gate says WHO is being asked, and the
          session the gate sits on is the one already loaded above. */}
            <PasscodeLock
                name={session.name}
                length={pinLength}
                deviceBound={deviceBound}
                enrolAvailable={enrolAvailable}
                rpId={cfEnv('WEBAUTHN_RP_ID')}
            />
            <Shell systemCode={system?.code ?? null}>{children}</Shell>
        </AddActionProvider>
    );
}

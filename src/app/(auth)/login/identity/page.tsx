import { redirect } from 'next/navigation';
import { Screen } from '@/components/ui/Screen';
import { getSession } from '@/lib/auth/session';
import { IdentityGate } from '@/features/kyc/components/IdentityGate';

/**
 * Identity verification — the step after the passcode.
 *
 * Every sign-in: a live face is compared against the reference photo the
 * backend holds. First sign-in only: the full ID enrolment runs after it
 * (ID → summary → liveness → match).
 *
 * ── Not yet gating anything ─────────────────────────────────────────────────
 * The backend contract is still being agreed (see SCENARIOS.md), so this page
 * is currently reachable for review and runs on `MockKycService`. Two things
 * land together when the API does:
 *
 *   1. `challengeId` comes from the server, not from here.
 *   2. The step token this returns is what mints the session — until then the
 *      passcode step still completes the login on its own, so nothing here can
 *      be "skipped" to gain access that the passcode did not already grant.
 *
 * The screens are drawn on the 430 XD canvas, so the flow renders as a centred
 * phone-width column (AGENTS.md §1).
 */
export default async function IdentityPage() {
    const session = await getSession();
    if (!session) redirect('/login');

    return (
        <Screen variant="centered" maxW={430} gutter={0} className="h-full">
            <IdentityGate
                user={{
                    id: session.id,
                    firstName: session.firstName,
                    lastName: session.lastName,
                }}
                // Placeholder: the real one is issued by the backend alongside
                // the passcode step's token.
                challengeId="preview"
                // Now a real server fact: `requires_kyc` on the session payload
                // (SCENARIOS.md §4c asked for exactly this).
                needsEnrollment={session.requiresKyc}
            />
        </Screen>
    );
}

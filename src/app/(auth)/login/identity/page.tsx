import { redirect } from 'next/navigation';
import { Screen } from '@/components/ui/Screen';
import { IdentityStep } from '@/features/auth/components/IdentityStep';
import { readChallenge } from '@/lib/auth/challenge';
import { redirectIfAuthenticated } from '@/lib/auth/guards';
import { STAGES } from '@/lib/auth/endpoints';

/**
 * The whole identity flow: face check, and — on a first login — ID enrolment.
 *
 * ── Why three stages share this one route ───────────────────────────────────
 * `FACE_REQUIRED` and `ID_DOCUMENT_REQUIRED` both land here.
 * The face captured in the first is reused when the ID is compared against it,
 * so the administrator never captures their face twice — and that frame is a
 * large data URL held in React state. Navigating between steps would unmount
 * the tree and drop it, and the only visible symptom would be a second capture
 * nobody asked for. See STAGE_ROUTES.
 *
 * ── It runs mid-challenge, with no session ──────────────────────────────────
 * This used to require a signed-in user, because identity was proven AFTER
 * sign-in. Under this protocol it runs INSIDE the challenge, before any token
 * exists, so the gate is the stage rather than a session.
 *
 * The screens are drawn on the 430 XD canvas, so the flow renders as a centred
 * phone-width column (AGENTS.md §1).
 */
export default async function IdentityPage() {
    await redirectIfAuthenticated();

    const challenge = await readChallenge();
    if (!challenge.challengeToken) redirect('/no-access');

    const identityStages: string[] = [STAGES.face, STAGES.idDocument];
    if (!identityStages.includes(challenge.stage ?? '')) {
        // The server is somewhere else entirely — /login re-routes from one place.
        redirect('/login');
    }

    return (
        <Screen variant="centered" maxW={430} gutter={0} className="h-full">
            <IdentityStep
                // Enrolment begins at the ID steps; the face check is already
                // behind us when the server reports one of those stages.
                needsEnrollment={challenge.stage !== STAGES.face}
                // Safe to hand to the client: an identifier, not a credential.
                // The KYC Worker needs it in a request body to say whose
                // sign-in it is holding, which is precisely why the backend
                // issues it separately from the challenge token — and the token
                // itself never leaves the server.
                challengeId={challenge.challengeId ?? ''}
            />
        </Screen>
    );
}

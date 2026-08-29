import { redirect } from 'next/navigation';
import { PrivateCodeScreen } from '@/features/auth/components/PrivateCodeScreen';
import { readChallenge } from '@/lib/auth/challenge';
import { redirectIfAuthenticated } from '@/lib/auth/guards';
import { STAGES, STAGE_ROUTES } from '@/lib/auth/endpoints';

/**
 * Step 1 of the flow the access link opens: enter the private code.
 *
 * The code arrives in the SAME WhatsApp message as the link, so by the time
 * anyone reaches this screen they are already holding it. There is nothing to
 * request, nothing to wait for, and no resend to offer — which is why this
 * screen is a heading and a field and nothing else.
 *
 * ── This file is the ROUTING; the layout is PrivateCodeScreen ───────────────
 * The markup lives in `features/auth/components/PrivateCodeScreen.tsx` so the
 * design gallery can render it without tripping the guards below.
 *
 * ── It routes ──────────────────────────────────────────────────────────────
 * Arriving here by back button or a typed URL when the server is further along
 * would mean posting a step it refuses — and a refused step burns the
 * challenge. So the stage is checked first and the browser is sent wherever the
 * server actually is, rather than spending one of five attempts to find out.
 *
 * No challenge at all means no sign-in is in progress, and the only thing that
 * starts one is an access link. That is a refusal, not an error, so it lands on
 * the same screen every other refusal does.
 */
export default async function LoginPage() {
    // Already signed in — nothing to do here.
    await redirectIfAuthenticated();

    const challenge = await readChallenge();

    if (!challenge.challengeToken) redirect('/no-access');

    // The server is further along than this screen. Follow it.
    if (challenge.stage !== STAGES.privateCode) {
        redirect(STAGE_ROUTES[challenge.stage ?? ''] ?? '/no-access');
    }

    return <PrivateCodeScreen />;
}

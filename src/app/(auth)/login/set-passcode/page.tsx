import { redirect } from 'next/navigation';
import { SetPasscodeFlow } from '@/features/auth/components/SetPasscodeFlow';
import { readLoginFlow } from '@/lib/auth/login-flow';
import { redirectIfAuthenticated } from '@/lib/auth/guards';
import { STAGE_PASS_CODE_REQUIRED } from '@/lib/auth/endpoints';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/** "super_admin" → "Super Admin" — display only. */
function roleLabel(role?: string) {
    return (role ?? '')
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Login — set a passcode on first login (6 digits).
 *
 * Gated on the backend's own stage plus a live challenge token: reaching here
 * means /v1/registration/otp answered PASS_CODE_REQUIRED. (It used to gate on a
 * `setupToken` that this backend does not issue.)
 */
export default async function SetPasscodePage() {
    // Already signed in — never show a sign-in step.
    await redirectIfAuthenticated();
    const flow = await readLoginFlow();
    if (flow.stage !== STAGE_PASS_CODE_REQUIRED || !flow.challengeToken) {
        redirect('/login');
    }

    return (
        <main className="flex h-full flex-col items-center">
            <div className="flex flex-col items-center justify-end" style={{ flexGrow: 2 }}>
                <h1 className="fz-30 text-ink h-38 flex items-center-safe w-full px-20 leading-none font-bold">
                    Set Passcode !
                </h1>
                <p
                    className="fz-16 text-ink w-full px-20 leading-none font-normal"
                    style={{ marginTop: rem(12) }}
                >
                    Your First Login
                </p>
                <p
                    className="fz-12 text-ink w-full px-20 leading-none font-normal"
                    style={{ marginTop: rem(12) }}
                >
                    {flow.name} {roleLabel(flow.role)}
                </p>

                <SetPasscodeFlow />
            </div>

            {/* Reserved (white) space for the on-screen keyboard on mobile/tablet. */}
            <div className="w-full" style={{ flexGrow: 3, marginTop: rem(20) }} aria-hidden />
        </main>
    );
}

import { IdentifyStep } from '@/features/auth/components/LoginSteps';
import { PasscodeGate } from '@/features/auth/components/PasscodeGate';
import { redirectIfAuthenticated } from '@/lib/auth/guards';
import { getPrivateCode } from '@/lib/auth/cookies';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Login — step 1: enter private code. Title + subtitle + code field are
 * horizontally centered in the white area; the bottom is the reserved on-screen
 * keyboard space (shown grey for now), 20 XD px below the field.
 *
 * Vertical split (top 2 : keyboard 3) places the field just above the keyboard,
 * matching the XD; gaps 12 (title→subtitle) and 88 (subtitle→field) are spec.
 */
export default async function LoginPage() {
    // Already signed in — nothing to do here.
    await redirectIfAuthenticated();

    // Signed in on this device before, so the private code is already known:
    // go straight to the passcode, which is the only other half /v1/auth/login
    // needs. First-time admins have no saved code and start at step 1.
    const privateCode = await getPrivateCode();
    if (privateCode) return <PasscodeGate mode="login" />;

    return (
        <main className="flex h-full flex-col items-center">
            {/* White content area — content anchored to its bottom (just above keyboard). */}
            <div className="flex flex-col items-center justify-end" style={{ flexGrow: 2 }}>
                <h1 className="fz-30 w-full h-38 flex items-center-safe px-20 text-ink leading-none font-bold">
                    Login !
                </h1>
                <p
                    className="fz-16 text-ink w-full px-20 leading-none font-normal"
                    style={{ marginTop: rem(12) }}
                >
                    Enter Your Private&nbsp; Code
                </p>

                <div style={{ marginTop: rem(88) }}>
                    <IdentifyStep />
                </div>
            </div>

            {/* Reserved (white) space for the on-screen keyboard on mobile/tablet,
          20 above the field. */}
            <div className="w-full" style={{ flexGrow: 3, marginTop: rem(20) }} aria-hidden />
        </main>
    );
}

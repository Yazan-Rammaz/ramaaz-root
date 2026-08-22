import { redirect } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { VerifyStep } from '@/features/auth/components/LoginSteps';
import { ResendTimer } from '@/features/auth/components/ResendTimer';
import { readLoginFlow } from '@/lib/auth/login-flow';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/** Login — WhatsApp verification code (6 digits). */
export default async function VerifyPage() {
    const flow = await readLoginFlow();
    if (!flow.challengeToken) redirect('/login');

    return (
        <main className="flex h-full flex-col items-center">
            <div className="flex flex-col items-center justify-end" style={{ flexGrow: 2 }}>
                <h1 className="fz-30 text-ink h-38 w-full px-20 leading-none flex items-center-safe font-bold">
                    Login !
                </h1>
                <p
                    className="fz-16 text-ink w-full px-20 leading-none font-medium"
                    style={{ marginTop: rem(12) }}
                >
                    Enter Verification Code Sent To Your Whatsapp
                </p>

                <p
                    className="fz-12 text-ink flex w-full items-center gap-6 px-20 leading-none font-normal"
                    style={{ marginTop: rem(8) }}
                >
                    We Have Sent A Verification Code To Your Number
                    <Icon
                        name="auth/phonenumber_send_otp"
                        width={15}
                        height={15}
                        mask
                        className="text-ink"
                    />
                </p>

                <p
                    className="fz-12 flex w-full items-center gap-6 px-20 leading-none"
                    style={{ marginTop: rem(8) }}
                >
                    {/* The number is deliberately NOT shown. The backend sends
                        a masked form ("•••••••••540"), but even that is an
                        identity detail leaking onto a pre-session screen that
                        anyone holding the private code can reach. The admin
                        knows their own number; nothing here needs to confirm
                        it. `flow.otpPhone` is still carried if a design ever
                        calls for it. */}
                    {/* Backend-driven, not a guess: it tells us when a resend
                        will be accepted. */}
                    <ResendTimer startSeconds={flow.otpResendAvailableIn ?? 60} />
                </p>

                <div style={{ marginTop: rem(42) }}>
                    <VerifyStep length={flow.otpLength ?? 6} />
                </div>
            </div>

            {/* Reserved (white) space for the on-screen keyboard on mobile/tablet. */}
            <div className="w-full" style={{ flexGrow: 3, marginTop: rem(20) }} aria-hidden />
        </main>
    );
}

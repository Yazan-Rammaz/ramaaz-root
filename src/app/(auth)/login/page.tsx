import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PrivateCodeStep } from '@/features/auth/components/PrivateCodeStep';
import { readChallenge } from '@/lib/auth/challenge';
import { redirectIfAuthenticated } from '@/lib/auth/guards';
import { STAGES, STAGE_ROUTES } from '@/lib/auth/endpoints';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Step 1 of the flow the access link opens: enter the private code.
 *
 * The code arrives in the SAME WhatsApp message as the link, so by the time
 * anyone reaches this screen they are already holding it. There is nothing to
 * request, nothing to wait for, and no resend to offer — which is why this
 * screen is a heading and a field and nothing else.
 *
 * ── It also routes ──────────────────────────────────────────────────────────
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

    const t = await getTranslations('auth');
    const challenge = await readChallenge();

    if (!challenge.challengeToken) redirect('/no-access');

    // The server is further along than this screen. Follow it.
    if (challenge.stage !== STAGES.privateCode) {
        redirect(STAGE_ROUTES[challenge.stage ?? ''] ?? '/no-access');
    }

    return (
        <main className="flex h-full flex-col items-center justify-center">
            {/*
              One left-aligned block, centred as a group. The heading lines up
              with the FIELD'S TEXT rather than its border, so it carries the
              same inset the input's padding gives its placeholder — which is
              why this is not simply `items-center`.
            */}
            <div className="flex flex-col items-start">
                <h1
                    className="fz-30 text-ink leading-none font-bold"
                    style={{ paddingInlineStart: rem(24) }}
                >
                    {t('title')}
                </h1>

                <p
                    className="fz-16 text-ink leading-none font-normal"
                    style={{ marginTop: rem(12), paddingInlineStart: rem(24) }}
                >
                    {t('subtitle')}
                </p>

                <div style={{ marginTop: rem(88) }}>
                    <PrivateCodeStep />
                </div>
            </div>
        </main>
    );
}

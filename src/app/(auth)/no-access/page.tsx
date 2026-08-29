import { getTranslations } from 'next-intl/server';
import { Icon } from '@/components/ui/Icon';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The one refusal screen.
 *
 * ── Why one screen for every cause ──────────────────────────────────────────
 * A link can fail for many reasons — unknown, revoked, expired, outside its
 * address range or country, or the account suspended — and the backend answers
 * all of them with a single indistinguishable `UNAUTHENTICATED`. Deliberately:
 * telling someone holding a forwarded link *which* condition tripped is telling
 * them how to get closer.
 *
 * This screen mirrors that. It is also what a bare visit with no token at all
 * lands on, so probing the root of the domain reveals nothing either — not even
 * that a sign-in exists here.
 *
 * ── No recovery is offered, because none exists ─────────────────────────────
 * There is no "try another way". A link is bound to a device once its passkey
 * is enrolled, and the only path back is another root administrator issuing a
 * fresh one. Saying that plainly is kinder than a button that cannot work.
 */
export default async function NoAccessPage() {
    const t = await getTranslations('auth');

    return (
        <main className="flex h-full flex-col items-center justify-center px-20">
            <Icon name="auth/no_access" width={96} height={96} alt="" />

            <h1
                className="fz-24 text-ink text-center leading-none font-bold"
                style={{ marginTop: rem(32) }}
            >
                {t('noAccessTitle')}
            </h1>

            <p
                className="fz-16 text-ink max-w-360 text-center leading-normal font-normal"
                style={{ marginTop: rem(16) }}
            >
                {t('noAccessBody')}
            </p>
        </main>
    );
}

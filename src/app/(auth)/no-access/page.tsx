import { getTranslations } from 'next-intl/server';
import { Icon } from '@/components/ui/Icon';
import { readLastLink, readSignInError } from '@/lib/auth/challenge';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The refusal screen.
 *
 * ── Why one screen for every CAUSE ──────────────────────────────────────────
 * A link can fail for many reasons — unknown, revoked, expired, outside its
 * address range or country, or the account suspended — and the backend answers
 * all of them with a single indistinguishable `UNAUTHENTICATED`. Deliberately:
 * telling someone holding a forwarded link *which* condition tripped is telling
 * them how to get closer. `signInError()` preserves that: every /auth/link
 * refusal maps to one sentence, so rendering the message below reveals nothing
 * the backend was not already willing to say.
 *
 * ── But two SITUATIONS, which is the fix for the WhatsApp reports ───────────
 * This page is reached two ways, and they need different words:
 *
 *   1. The backend refused the link. `/enter/[token]` records why in the
 *      one-shot error cookie, so a message is present.
 *
 *   2. There is no sign-in in this browser at all — every screen redirects
 *      here when the challenge cookie is missing. No message is present,
 *      because nothing was refused.
 *
 * Case 2 is what an administrator opening the link from WhatsApp hits, and
 * telling them they "don't have access" was simply wrong. The challenge lives
 * entirely in an httpOnly cookie; WhatsApp opens links in an in-app browser,
 * and tapping "open in Chrome/Safari" — which the passkey step all but forces,
 * since WebAuthn is unreliable in a WebView — starts again in an empty cookie
 * jar. Nothing is revoked. They just have to open the link in the browser they
 * intend to finish in, and now the screen says so.
 *
 * ── No recovery is offered for case 1, because none exists ──────────────────
 * There is no "try another way". A link is bound to a device once its passkey
 * is enrolled, and the only path back is another root administrator issuing a
 * fresh one. Saying that plainly is kinder than a button that cannot work.
 */
export default async function NoAccessPage() {
    const t = await getTranslations('auth');

    // Absent means nothing was refused — see case 2 above.
    const refusal = await readSignInError();

    // The link this browser last tried, when one is known. Absent for every
    // arrival that never had a link to begin with.
    const lastLink = await readLastLink();

    const title = refusal ? t('noAccessTitle') : t('noSessionTitle');
    const body = refusal ?? t('noSessionBody');

    return (
        <main className="flex h-full flex-col items-center justify-center px-20">
            <Icon name="auth/no_access" width={96} height={96} alt="" />

            <h1
                className="fz-24 text-ink text-center leading-none font-bold"
                style={{ marginTop: rem(32) }}
            >
                {title}
            </h1>

            <p
                className="fz-16 text-ink max-w-360 text-center leading-normal font-normal"
                style={{ marginTop: rem(16) }}
            >
                {body}
            </p>

            {refusal ? (
                <p
                    className="fz-14 text-ink/60 max-w-360 text-center leading-normal font-normal"
                    style={{ marginTop: rem(12) }}
                >
                    {t('noAccessBody')}
                </p>
            ) : null}

            {/*
              The way back in — and ONLY when there is one.

              We already know the link: whatever refused it recorded the token
              (see `setLastLink`), so this is a plain anchor back to the same
              `/enter/<token>` the message points at. There is nothing to ask
              the administrator for and nothing to type.

              When no token is known — a browser that never held a link, or one
              that arrived after the cookie aged out — NOTHING renders. A "try
              again" with nothing behind it is worse than silence: it invites a
              press that can only end on this same screen.

              An `<a>`, not a button: /enter is a Route Handler, so this must be
              a document navigation. That also makes it the one control here
              that needs no JavaScript at all.
            */}
            {lastLink ? (
                <>
                    <p
                        className="fz-14 text-ink/70 max-w-360 text-center leading-normal font-normal"
                        style={{ marginTop: rem(40) }}
                    >
                        {t('reenterPrompt')}
                    </p>
                    <a
                        href={`/enter/${encodeURIComponent(lastLink)}`}
                        className="fz-14 text-primary leading-none font-semibold underline"
                        style={{ marginTop: rem(12) }}
                    >
                        {t('reenterCta')}
                    </a>
                </>
            ) : null}
        </main>
    );
}

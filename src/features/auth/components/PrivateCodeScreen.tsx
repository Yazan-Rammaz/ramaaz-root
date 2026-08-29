import { getTranslations } from 'next-intl/server';
import { PrivateCodeStep } from './PrivateCodeStep';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The private-code screen's LAYOUT, with no routing in it.
 *
 * Split from `app/(auth)/login/page.tsx` so the markup has one home. The page
 * still owns every decision — already signed in, no challenge, server further
 * along — and this owns only what those decisions end in. The design gallery
 * renders this directly, which is the reason for the split: the guards make the
 * route unreachable without a live challenge, and a second copy of the markup
 * for previewing would drift from the first the day either is touched.
 */
export async function PrivateCodeScreen() {
    const t = await getTranslations('auth');

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

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AuthCodeField } from './AuthCodeField';
import { restartSignInAction, submitPrivateCodeAction } from '../actions';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The private code — the only value this protocol asks anyone to type.
 *
 * It arrives in the same WhatsApp message as the access link, so there is
 * nothing to request, resend or wait for. The screen's whole job is to take it.
 *
 * ── Free-form on purpose ────────────────────────────────────────────────────
 * No client-side format check. The code is issued by the backend and its shape
 * is the backend's to change; a regex here would reject a perfectly valid code
 * the day that format moves, and would need a frontend release to fix. The
 * server is the real check either way.
 *
 * The arrow appears once anything is typed, so the control never looks disabled
 * for a reason the user cannot see.
 *
 * On success the ACTION redirects (server-side), so there is no client
 * navigation here — which is what keeps every token inside httpOnly cookies.
 */
export function PrivateCodeStep() {
    const t = useTranslations('auth');
    const [error, setError] = useState<string | null>(null);
    const [dead, setDead] = useState(false);

    if (dead) {
        return (
            <div className="flex flex-col items-center gap-16">
                <p
                    role="alert"
                    className="fz-14 px-20 text-center leading-normal font-medium text-red-500"
                >
                    {error ?? t('expired')}
                </p>
                <button
                    type="button"
                    className="fz-14 text-primary leading-none font-semibold underline"
                    onClick={() => void restartSignInAction()}
                >
                    {t('startOver')}
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col">
            <AuthCodeField
                placeholder={t('privateCodePlaceholder')}
                ariaLabel={t('privateCodePlaceholder')}
                revealArrowAt={1}
                onSubmit={async (value) => {
                    setError(null);
                    // A correct code redirects inside the action, so only a
                    // failure comes back here.
                    const result = await submitPrivateCodeAction(value);
                    if (!result?.error) return;
                    if (result.restart) setDead(true);
                    setError(result.error);
                }}
            />

            {/* Height reserved so the layout does not jump as errors appear. */}
            <p
                role="alert"
                className="fz-12 min-h-16 w-full px-20 text-start leading-none font-medium text-red-500"
                style={{ marginTop: rem(12) }}
            >
                {error ?? ''}
            </p>
        </div>
    );
}

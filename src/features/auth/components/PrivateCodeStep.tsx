'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AuthCodeField } from './AuthCodeField';
import { kickstartLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';
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

    /**
     * Start downloading the face model NOW, while they type.
     *
     * The face step needs ~6.6MB over the wire before it can capture anything:
     * 3.1MB of MediaPipe WASM and 3.4MB of model weights (measured against the
     * deployed worker, brotli'd). Left until that screen mounts, the whole
     * download happens with the person already staring at the frame waiting for
     * something to happen — which is most of why the check felt broken.
     *
     * Typing a code takes ten to thirty seconds. That is free time, and it is
     * enough to cover the download outright on wifi and most of it on 4G.
     * `kickstartLandmarker` is idempotent (the promise is cached), exists for
     * exactly this, and had never been called from anywhere.
     *
     * Fire-and-forget by design: it cannot fail loudly here, and it must not —
     * a slow model is not a reason to block someone entering their code.
     */
    useEffect(() => {
        kickstartLandmarker();
    }, []);

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

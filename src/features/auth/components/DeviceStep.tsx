'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import {
    credentialToJSON,
    deviceLabel,
    isWebAuthnAvailable,
    toPublicKeyOptions,
} from '@/lib/auth/webauthn';
import { deviceOptionsAction, restartSignInAction, submitDeviceAction } from '../actions';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

type Phase = 'starting' | 'prompting' | 'submitting' | 'error' | 'dead';

/**
 * Stage `DEVICE_REQUIRED` — the passkey.
 *
 * ── What this step actually is ──────────────────────────────────────────────
 * On a first login it binds the access link to this device permanently, and it
 * is what replaces the PIN. On every later login it is the FIRST thing asked,
 * before the face — a browser without the bound passkey gets a ceremony it
 * cannot answer, which is the intended outcome rather than an error to smooth
 * over.
 *
 * The server decides which of those two it is, and says so in `mode`. This
 * component never chooses: picking client-side is exactly what would let a
 * stranger ask to "register" on a link already bound to somebody else.
 *
 * ── Why it starts by itself ─────────────────────────────────────────────────
 * The ceremony opens the browser's own authenticator prompt, so a button here
 * would only ever mean "show me the real prompt". It runs on mount and offers a
 * retry if the person dismisses it — which is common, and not a failure.
 */
export function DeviceStep() {
    const t = useTranslations('auth');
    const [phase, setPhase] = useState<Phase>('starting');
    const [error, setError] = useState<string | null>(null);
    const started = useRef(false);

    const run = useCallback(async () => {
        setError(null);
        setPhase('starting');

        if (!isWebAuthnAvailable()) {
            setError(t('deviceUnsupported'));
            setPhase('error');
            return;
        }

        const options = await deviceOptionsAction();
        if (!options.ok || !options.publicKey || !options.mode) {
            setError(options.error ?? t('deviceFailed'));
            setPhase(options.restart ? 'dead' : 'error');
            return;
        }

        let credential: PublicKeyCredential | null;
        try {
            setPhase('prompting');
            const publicKey = toPublicKeyOptions(options.publicKey, options.mode);
            // The two values that decide whether this ceremony can run at all:
            // `mode` (register vs authenticate — the server picks, and a link
            // already bound gets "authenticate" on a device that cannot
            // answer), and `rp.id`, which MUST match this origin. A passkey
            // cannot be bound to an IP address, so an rp.id that is a domain
            // while the page is served from 192.168.x.x fails before the
            // prompt appears.
            console.info('[device] ceremony:', {
                mode: options.mode,
                rp: (options.publicKey as { rp?: unknown }).rp,
                origin: window.location.origin,
            });
            credential = (await (options.mode === 'register'
                ? navigator.credentials.create({
                      publicKey: publicKey as PublicKeyCredentialCreationOptions,
                  })
                : navigator.credentials.get({
                      publicKey: publicKey as PublicKeyCredentialRequestOptions,
                  }))) as PublicKeyCredential | null;
        } catch (err) {
            // Dismissing the prompt, or no matching passkey on this device. Both
            // land here as the same DOMException, and neither is worth a
            // different message to the person: the honest advice is "try
            // again", and on a returning login "not on this device" is covered
            // by the copy.
            //
            // The exception NAME is another matter and belongs in the console,
            // because three very different faults arrive here wearing the same
            // face:
            //   NotAllowedError — dismissed, timed out, OR called without a
            //                     user gesture, which iOS Safari requires and
            //                     desktop Chrome does not
            //   SecurityError   — rp.id does not match this origin; a passkey
            //                     cannot be bound to an IP address at all
            //   InvalidStateError — this authenticator already holds a
            //                     credential for this account
            // Without the name, "cancelled" is the only story available for all
            // three, and only one of them is the user's doing.
            const e = err as { name?: string; message?: string };
            console.error('[device] ceremony failed:', e?.name, e?.message);
            setError(t('deviceCancelled'));
            setPhase('error');
            return;
        }

        if (!credential) {
            setError(t('deviceCancelled'));
            setPhase('error');
            return;
        }

        setPhase('submitting');
        // Success redirects inside the action, so only a failure returns.
        const result = await submitDeviceAction(credentialToJSON(credential), deviceLabel());
        if (result?.error) {
            setError(result.error);
            setPhase(result.restart ? 'dead' : 'error');
        }
    }, [t]);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void run();
    }, [run]);

    if (phase === 'dead') {
        return (
            <main className="flex h-full flex-col items-center justify-center px-20">
                <p
                    role="alert"
                    className="fz-14 max-w-320 text-center leading-normal font-medium text-red-500"
                >
                    {error ?? t('expired')}
                </p>
                <button
                    type="button"
                    className="fz-14 text-primary leading-none font-semibold underline"
                    style={{ marginTop: rem(24) }}
                    onClick={() => void restartSignInAction()}
                >
                    {t('startOver')}
                </button>
            </main>
        );
    }

    const busy = phase === 'starting' || phase === 'prompting' || phase === 'submitting';

    return (
        <main className="flex h-full flex-col items-center justify-center px-20">
            <Icon name="auth/pin_lock" width={40} height={56} alt="" />

            <h1
                className="fz-24 text-ink text-center leading-none font-bold"
                style={{ marginTop: rem(32) }}
            >
                {t('deviceTitle')}
            </h1>

            <p
                className="fz-16 text-ink max-w-360 text-center leading-normal font-normal"
                style={{ marginTop: rem(16) }}
            >
                {t('deviceBody')}
            </p>

            <p
                role="status"
                aria-live="polite"
                className="fz-14 min-h-20 max-w-360 text-center leading-normal font-medium"
                style={{ marginTop: rem(24) }}
            >
                {busy ? (
                    <span className="text-[#707070]">{t('devicePrompting')}</span>
                ) : (
                    <span className="text-red-500">{error}</span>
                )}
            </p>

            {phase === 'error' ? (
                <button
                    type="button"
                    className="hairline fz-16 h-56 w-320 rad-28 leading-none font-normal text-[#707070] transition-colors hover:text-[#1D1D1D]"
                    style={
                        {
                            marginTop: rem(8),
                            '--hairline-radius': rem(28),
                            '--hairline-color': '#C3C3C3',
                            '--hairline-dash': '3 3',
                        } as React.CSSProperties
                    }
                    onClick={() => void run()}
                >
                    {t('deviceRetry')}
                </button>
            ) : null}
        </main>
    );
}

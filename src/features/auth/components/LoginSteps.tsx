'use client';

import { useEffect, useState } from 'react';
import { AuthCodeField } from './AuthCodeField';
import { PasscodeBoxes } from './PasscodeBoxes';
import { useCodeFeedback } from '../use-code-feedback';
import { OTP_RESENT_EVENT } from '../otp-events';
import { useDevCredentials } from '../dev/useDevCredentials';
import { identifyAction, passwordAction, verifyOtpAction, type ActionState } from '../actions';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Client glue for the login steps: each wraps the step's designed input, calls
 * its Server Action, and shows the returned error. On success the ACTION
 * redirects (server-side), so there is no client navigation here — which is
 * what keeps every token inside httpOnly cookies.
 */

/**
 * Centred under the field it belongs to, with its height reserved so the
 * layout does not jump as messages appear and clear.
 */
function ErrorText({ error }: { error?: string }) {
    return (
        <p
            role="alert"
            className="fz-12 min-h-16 w-full px-20 text-center leading-none font-medium text-red-500"
            style={{ marginTop: rem(12) }}
        >
            {error ?? ''}
        </p>
    );
}

/** Step 1 — private code. */
export function IdentifyStep() {
    const [state, setState] = useState<ActionState>({ ok: true });
    // TEMPORARY dev autofill — off unless NEXT_PUBLIC_DEV_AUTOFILL=1.
    // `true` = mint a fresh admin, so this screen always offers an unspent
    // invitation token rather than credentials a previous run already burned.
    const dev = useDevCredentials(true);
    return (
        <div className="flex flex-col items-center">
            <AuthCodeField
                // Remount when the value arrives, so it becomes initial state.
                key={dev?.privateCode ?? 'empty'}
                defaultValue={dev?.privateCode}
                placeholder="Enter Your Private  Code"
                ariaLabel="Enter Your Private Code"
                revealArrowAt={7}
                maxLength={32}
                onSubmit={async (value) => {
                    // Success redirects inside the action (303) and settles with no
                    // value — only a failure returns a state to show.
                    const result = await identifyAction(value);
                    if (result?.error) setState(result);
                }}
            />
            <ErrorText error={state.error} />
        </div>
    );
}

/** Step 2 — password. */
export function PasswordStep() {
    const [state, setState] = useState<ActionState>({ ok: true });
    // Reads the same cached credentials step 1 fetched — no second reset.
    const dev = useDevCredentials();
    return (
        <div className="flex flex-col items-center">
            <AuthCodeField
                key={dev?.password ?? 'empty'}
                defaultValue={dev?.password}
                placeholder="Enter Your Password"
                ariaLabel="Enter Your Password"
                revealArrowAt={8}
                onSubmit={async (value) => {
                    const result = await passwordAction(value);
                    if (result?.error) setState(result);
                }}
            />
            <ErrorText error={state.error} />
        </div>
    );
}

/**
 * Step 3 — the 6-digit WhatsApp code. Wrong code clears the boxes. The
 * passcode step always follows (set or enter) — that step does the unlocking.
 */
export function VerifyStep({ length = 6 }: { length?: number }) {
    const { phase, error, round, fail, clearError } = useCodeFeedback();

    // A resent code makes the previous failure irrelevant. <ResendTimer> is a
    // sibling in the page, so it announces on the window rather than the two
    // being wired through a shared parent for one boolean.
    useEffect(() => {
        window.addEventListener(OTP_RESENT_EVENT, clearError);
        return () => window.removeEventListener(OTP_RESENT_EVENT, clearError);
    }, [clearError]);

    return (
        <div className="flex flex-col items-center">
            <PasscodeBoxes
                key={round}
                // Box count comes from the backend's `code_length`, so a change there
                // doesn't silently break the input.
                length={length}
                success={phase === 'success'}
                error={phase === 'error'}
                onInput={clearError}
                onComplete={async (value) => {
                    // A correct code redirects inside the action, so only a
                    // failure comes back here.
                    const result = await verifyOtpAction(value);
                    if (result?.error) fail(result.error);
                }}
            />
            <ErrorText error={error ?? undefined} />
        </div>
    );
}

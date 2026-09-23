'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AuthCodeField } from './AuthCodeField';
import { kickstartLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';
import { restartSignInAction, submitPrivateCodeAction } from '../actions';
import { reportUserError } from '@/components/Observe';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The private code — the only value this protocol asks anyone to type.
 *
 * ── The administrator PULLS it, and there is no resend ──────────────────────
 * They message the trigger phrase to the system's WhatsApp number from their
 * registered handset, and the code comes back to that handset. No endpoint
 * sends it, and deliberately none will: a code the console could request on
 * somebody's behalf would prove nothing about who holds the link.
 *
 * ⚠️ ONE ATTEMPT PER CODE. A wrong answer does not cost a guess, it costs the
 * CODE — there is no second try at the same one. The challenge survives, but
 * the only way forward is to message the number again, so a refusal has to lead
 * with that instruction rather than leave somebody retyping into a field whose
 * contents can no longer work. `codeSpent` on the action's result is that
 * signal.
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
export function PrivateCodeStep({
    /**
     * How long a code lasts on this deployment, from the server. Absent is
     * normal — an older backend, or a resumed challenge whose first response we
     * never saw — and the instruction simply drops the duration rather than
     * guessing one.
     */
    ttlSeconds,
}: {
    ttlSeconds?: number;
} = {}) {
    const t = useTranslations('auth');
    const [error, setError] = useState<string | null>(null);
    const [dead, setDead] = useState(false);
    /** The last code was consumed — they need a new one before typing again. */
    const [spent, setSpent] = useState(false);

    /**
     * The standing line about the code's lifetime. On screen from the moment
     * the page opens, not after a failure and not on a timer.
     *
     * ⚠️ IT DOES NOT SAY HOW TO GET A CODE, and that omission is deliberate.
     * It used to: "message the system on WhatsApp", on the reasoning that there
     * is no resend endpoint, so naming the channel was the only route to a code
     * and the first thing anybody arriving without one needed. That reasoning
     * is sound about the FLOW and wrong about the AUDIENCE — this screen is
     * reachable by whoever holds the access link, and that is not necessarily
     * the administrator. Printing the out-of-band channel there hands a
     * stranger the next step of the attack: the one thing they are missing is
     * where the code comes from, and the screen was telling them.
     *
     * A real administrator already knows how their codes arrive; they were
     * enrolled through it. So the line now carries only what is true of the
     * code itself and useful to somebody who has one — that it is single-use
     * and short-lived — which is also the part that stops people typing a code
     * they were sent ten minutes ago and reading the refusal as a rejection.
     *
     * Minutes past ninety seconds, plain seconds below it. Rounding 500s to
     * "8 minutes" is honest; rounding 50s to "1 minute" is not, and the
     * difference between those two is the whole reason the backend stopped
     * letting us assume either.
     */
    const hint =
        ttlSeconds === undefined
            ? t('codeHint')
            : ttlSeconds >= 90
              ? t('codeHintMinutes', { minutes: Math.round(ttlSeconds / 60) })
              : t('codeHintSeconds', { seconds: ttlSeconds });

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

    return (
        <div className="flex flex-col">
            <AuthCodeField
                placeholder={t('privateCodePlaceholder')}
                ariaLabel={t('privateCodePlaceholder')}
                revealArrowAt={1}
                // The moment they touch the code, the message about the LAST
                // one stops being true — so it goes, and stays gone until the
                // server refuses something again. Nothing else brings it back:
                // no timer, no re-render, no blur.
                onValueChange={() => {
                    setError(null);
                    // The instruction stays until they start typing the NEXT
                    // code — which is the moment it stops being the next thing
                    // to do.
                    setSpent(false);
                }}
                onSubmit={async (value) => {
                    setError(null);
                    // A correct code redirects inside the action, so only a
                    // failure comes back here. Whatever the backend said is
                    // shown verbatim — it is the only party that knows why.
                    const result = await submitPrivateCodeAction(value);
                    if (!result?.error) return;
                    if (result.restart) setDead(true);
                    if (result.codeSpent) setSpent(true);
                    setError(result.error);
                    // The action answered HTTP 200 — the refusal exists only in
                    // this body, so without reporting it the session reads as a
                    // clean sign-in that simply stopped.
                    reportUserError(result.error, result.diag);
                }}
            />

            {/*
              The error's own strip, and it CANNOT move anything.

              Reserving a min-height was not enough. This block is centred in
              the viewport by the screen around it, so a message long enough to
              wrap grew the block and shifted the heading, the subtitle and the
              field itself upward — the layout jumped at the exact moment the
              user was reading. The strip is now a fixed 16 with the text taken
              out of flow inside it, so a message of any length renders into the
              empty space below the field and displaces nothing.

              The height and the 12 above it are the space the screen already
              reserved, unchanged, so nothing moves compared to before either.
            */}
            <div className="relative h-16 w-full" style={{ marginTop: rem(12) }}>
                {/*
                  One line, two jobs. The standing instruction lives here and
                  the error takes its place while there is one — rather than
                  stacking, which would push the second line into the space the
                  `spent` note below already occupies.

                  Nothing is ever empty here, so the strip never looks broken
                  and the layout cannot shift between states.
                */}
                <p
                    role={error ? 'alert' : undefined}
                    className={`fz-12 absolute inset-x-0 top-0 px-20 text-center leading-none font-medium ${
                        error ? 'text-red-500' : 'text-ink/70'
                    }`}
                >
                    {error ?? hint}
                </p>

                {/*
                  What to DO about a spent code, under the sentence saying it
                  was refused.

                  The backend's message names the fact ("that code is not
                  valid"); this names the move. They are separate lines because
                  the first is the server's wording and the second is ours, and
                  because the field stays usable — the new code goes into the
                  same one, into the same live challenge.

                  ⚠️ "A new one" WITHOUT SAYING WHERE FROM, for the reason on
                  `hint` above: whoever is reading this is not necessarily the
                  administrator, and the channel a code arrives on is the one
                  thing a stranger holding the link does not already have. What
                  is still worth saying is that this field remains the place to
                  type it — the challenge is alive and retyping here works.

                  Out of flow like everything else in this strip, so appearing
                  displaces nothing.
                */}
                {spent && !dead && (
                    <p
                        className="fz-12 text-ink/70 absolute inset-x-0 px-20 text-center leading-none font-medium"
                        style={{ top: rem(20) }}
                    >
                        {t('codeSpent')}
                    </p>
                )}

                {/*
                  Only when the SEQUENCE is gone (CHALLENGE_INVALID), and even
                  then the field above stays where it is and stays usable. This
                  is an extra way out, never a replacement for the input.

                  Out of flow like the message, and below it, so appearing costs
                  nothing in layout.
                */}
                {dead && (
                    <button
                        type="button"
                        className="fz-12 text-primary absolute inset-x-0 px-20 text-start leading-none font-semibold underline"
                        style={{ top: rem(20) }}
                        onClick={() => void restartSignInAction()}
                    >
                        {t('startOver')}
                    </button>
                )}
            </div>
        </div>
    );
}

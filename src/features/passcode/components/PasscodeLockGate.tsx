'use client';

import { useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cardOpen, iosEase, iosSpring, lineSwap } from '@/components/motion/presets';
import { FlexSpace } from '@/components/ui/FlexSpace';
import { PasscodeBoxes } from '@/features/auth/components/PasscodeBoxes';
import { useCodeFeedback } from '@/features/auth/use-code-feedback';
import { PASSCODE_LENGTH } from '../schema';
import { sweepLegacyStorage } from '../store';
import { passkeyLabel, type PasskeyDriver } from '../passkey';
import { PasskeyUnlock } from './PasskeyUnlock';
import { UserAvatar } from './UserAvatar';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * THE passcode screen — a gate over the dashboard, not a route.
 *
 * An overlay because it must not navigate: the page underneath is where the
 * administrator already was, and returning them to it is the entire outcome of
 * getting the passcode right. Making this a route is what produced a redirect
 * loop the last time it was tried — the dashboard bounced to the passcode page,
 * which bounced back.
 *
 * ── It shows WHO is being asked ─────────────────────────────────────────────
 * Their own face and their own name, because the question "is it still you"
 * only means something if the screen has already said who "you" is. Both come
 * from the backend — the name as a prop, the photo through `/api/admin-photo`
 * (see `UserAvatar`); with no photo it falls back to the avatar glyph rather
 * than to somebody else's picture.
 *
 * ── What this is and is NOT ─────────────────────────────────────────────────
 * A UX lock, the same one `<IdleLock>` documents: the session cookie stays
 * valid throughout — that is the point, locking must never sign anyone out — so
 * anyone with devtools and this browser can dismiss it. Every real rule stays
 * server-side, including the PIN itself, which the backend checks. The way
 * out below SIGNS OUT rather than quietly letting someone past — there is no
 * PIN reset.
 */
/**
 * The verdict on one entry: through, or the sentence to show under the row.
 * A sentence rather than a boolean so the backend check can say "wait 36
 * seconds" where the local one could only ever say "wrong".
 */
export type PasscodeVerdict =
    /**
     * `hold`: through, but keep the gate up — a passkey setup still needs a tap
     * to finish (see `start`). Only the gate itself sets it.
     */
    | { ok: true; hold?: boolean }
    | { ok: false; error: string };

export function PasscodeLockGate({
    name,
    onUnlocked,
    onSignOut,
    verify,
    passkey,
    length = PASSCODE_LENGTH,
    preview = false,
}: {
    /** Display only — from the session the dashboard layout already loaded. */
    name?: string;
    onUnlocked: () => void;
    onSignOut: () => void;
    /**
     * Who judges the entry — always the backend: `unlockAction` on the lock
     * and /unlock, `submitPassCodeAction` at sign-in. Only the gallery leaves
     * it out, and it passes `preview`.
     */
    verify?: (code: string) => Promise<PasscodeVerdict>;
    /**
     * The passkey under the row, and the endpoints it runs on — see
     * `PasskeyDriver`. Absent means none is offered (the design gallery).
     */
    passkey?: PasskeyDriver;
    /** Digits in the PIN — the backend's `pass_code_length`, when known. */
    length?: number;
    /**
     * Accept any six digits — for /design, which mounts this over the dashboard
     * shell with no passcode stored and would otherwise be a screen that cannot
     * be opened at all.
     *
     * ⚠️ A REVIEW AFFORDANCE, never a mode. Nothing in `app/(dashboard)` passes
     * it and no branch here can set it, so the only way to reach this is to
     * render the component yourself.
     */
    preview?: boolean;
}) {
    const t = useTranslations('passcode');
    const reduce = useReducedMotion();
    const { phase, error, round, fail, succeed, settle, clearError } = useCodeFeedback();
    /**
     * Whether this browser leads with the passkey. Decides only whether the
     * passcode row takes focus on mount — see `autoFocus` below.
     */
    const passkeyEnrolled = passkey?.bound === true;
    /**
     * Passkey setup is armed: the next PIN opens a registration
     * (`passkey.enrol.prepare`) instead of unlocking. See `PasskeyUnlock`.
     */
    const [armed, setArmed] = useState(false);
    /** The registration options that PIN opened — hands the control its "finish". */
    const [enrolOptions, setEnrolOptions] = useState<Record<string, unknown> | null>(null);
    /**
     * A setup was refused because this device already holds one of the link's
     * passkeys. The control then offers it ("use this device") instead of
     * setup. See `exists` in `PasskeyDriver.enrol.finish`.
     */
    const [deviceHasPasskey, setDeviceHasPasskey] = useState(false);

    /**
     * The check, in flight.
     *
     * ── Why it is started separately from being acted on ────────────────────
     * `verify` is a request to the backend, and a request has no business
     * waiting for an animation. It
     * goes out on the KEYSTROKE, while the last box is still closing over its
     * digit; the answer is applied once the row has settled. Run in sequence
     * instead, the round trip would start half a second late and every unlock
     * would be that much slower for nothing.
     *
     * A ref, not state: nothing renders from it, and a re-render between
     * starting the check and reading it must not drop the promise.
     */
    const check = useRef<Promise<PasscodeVerdict> | null>(null);

    function start(value: string): Promise<PasscodeVerdict> {
        const enrol = armed ? passkey?.enrol : undefined;
        return (check.current = preview
            ? Promise.resolve({ ok: true })
            : enrol
              ? enrol.prepare(value).then(async (result): Promise<PasscodeVerdict> => {
                    if (!result.ok) return { ok: false, error: result.error };
                    // Accepted, but no setup could be opened — in, without it.
                    if (!result.publicKey) return { ok: true };
                    /*
                     * Straight into the device prompt — no "tap to finish".
                     *
                     * The last PIN keystroke is the user activation `create()`
                     * needs, and it is still fresh because this runs the moment
                     * the PIN check answers, not after the row's animation. A
                     * browser that has already let it lapse refuses instantly
                     * (`blocked`), and only then does the control ask for a tap.
                     */
                    const outcome = await enrol.finish(result.publicKey, passkeyLabel(name));
                    if (outcome === 'blocked') {
                        setEnrolOptions(result.publicKey);
                        return { ok: true, hold: true };
                    }
                    if (outcome === 'ok') return { ok: true };
                    /*
                     * This device already has the passkey — another browser on
                     * it made it (Safari and Chrome on an iPhone share iCloud
                     * Keychain). Use it now, in the same flow; this browser
                     * learns its id from the assertion and offers it on its own
                     * from then on.
                     *
                     * If the browser will not open a second prompt without a
                     * fresh tap, the control turns into "use this device" and
                     * the row says so — never "try again", which cannot work.
                     */
                    if (outcome === 'exists' && passkey) {
                        setArmed(false);
                        const used = await passkey.authenticate(
                            new AbortController().signal,
                            'optional',
                            false,
                        );
                        if (used === 'ok') return { ok: true };
                        setDeviceHasPasskey(true);
                        return { ok: false, error: t('passkeyExists') };
                    }
                    /*
                     * ⚠️ NOT let in. The options call only CHECKED the PIN — it
                     * neither completes a sign-in nor unlocks; the credential
                     * being accepted is what does. So a dismissed or refused
                     * prompt leaves them where they were: disarmed, the row
                     * cleared, and the next PIN typed unlocks as usual.
                     */
                    setArmed(false);
                    return { ok: false, error: t('passkeyFailed') };
                })
              : verify
                ? verify(value)
                : // No judge at all — only the gallery, which passes `preview`.
                  Promise.resolve({ ok: false, error: t('unavailable') }));
    }

    async function submit(value: string) {
        // Normally already in flight from `onFilled`. Starting it here as well
        // is the fallback for a row that reported completion without having
        // reported being full — which nothing does today, and which would
        // otherwise hang the gate on a promise that was never created.
        const verdict = await (check.current ?? start(value));
        check.current = null;

        if (verdict.ok) {
            // `hold`: a passkey setup the browser would not start without a
            // fresh tap. The row goes green and the gate STAYS, so the control
            // beneath can be tapped to finish; that tap dismisses it.
            succeed(verdict.hold ? () => {} : onUnlocked);
            return;
        }
        fail(verdict.error);
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={t('prompt')}
            // `fixed`, so it covers the shell whatever is scrolled beneath it,
            // and above every z-index the dashboard uses.
            className="fixed inset-0 z-50"
        >
            {/*
              ── The glass is a SIBLING of the content, not its parent ────────
              `.lock-glass` (globals.css) is the one thing in this app that
              filters a real backdrop rather than a copy of a picture — the
              dashboard is live DOM and there is no copy of it to draw — and a
              full-viewport 50px blur is the most expensive paint on the screen
              by a wide margin.

              ⚠️ IT USED TO WRAP EVERYTHING, and typing felt heavy because of
              it: every frame of every box animation was a frame inside a layer
              carrying that blur, so the compositor had the whole pane in hand
              for a 60px box growing 8%. As a sibling it has NO animating
              descendants at all — it paints once, and the row moves in its own
              layer above it.

              What it filters is unaffected: `backdrop-filter` samples what is
              BEHIND the element, and the dashboard is still behind it.
            */}
            <motion.div
                aria-hidden
                className="lock-glass absolute inset-0"
                /*
                 * The pane FADES IN — it does not appear.
                 *
                 * This lands over the page somebody was working on, mid-sentence
                 * when the idle timer fires and instantly when they press the
                 * lock. Cutting to it reads as a crash; a short wash reads as
                 * glass sliding over the work, which is the thing it is meant to
                 * be. The ~0.35s of `iosEase` is the same curve the app
                 * navigates with, so locking feels like part of the app rather
                 * than an interruption from outside it.
                 *
                 * This is the one moment the blur is re-rasterised, and it is
                 * once per lock rather than once per keystroke.
                 */
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={iosEase}
            />

            {/* The contents arrive a touch behind the glass and lift into
                place, so the question is the last thing to settle. */}
            <motion.div
                className="relative flex h-full w-full flex-col items-center"
                variants={cardOpen}
                initial={reduce ? 'animate' : 'initial'}
                animate="animate"
                transition={iosSpring}
            >
                {/*
          ⚠️ MEASURED GAPS, NOT `justify-center`. The stack was centred as a
          group, which is the obvious thing to do with an overlay and puts every
          element in the wrong place: centring solves for the MIDDLE of the
          content, and the frame specifies its two ENDS — the verified mark 394
          from the top, "Forget Passcode ?" 353 from the bottom. Those only
          coincide with centred output at one content height, and this content
          changes height (a name may be absent).

          190 puts the mark at 394: the portrait is 200 square with a 4 gap
          under it, so 190 + 200 + 4 = 394. The rest of the stack measures 185
          more, ending at 579 — which is 353 off a 932 canvas.

          Both spacers shrink, so a laptop viewport takes the shortfall out of
          each in proportion rather than out of the foot alone. See FlexSpace.
          The portrait itself never changes shape: it is 200 square on every
          canvas and scales with the engine like everything else, so these two
          numbers hold everywhere rather than only on the phone.
        */}
                <FlexSpace size={190} share={1} />

                <div className="flex h-200 w-200 shrink-0 items-center justify-center overflow-hidden rad-20 bg-muted/40">
                    {/* Sized to the plate exactly. `<Icon>` writes its dimensions
                        inline, which beats the `h-full w-full` class on it — so
                        the fallback glyph is whatever is passed here, and only
                        a matching number fills the plate without cropping. The
                        photograph ignores all of this and covers the box. */}
                    <UserAvatar width={200} height={200} />
                </div>

                {/* Verified — the same mark the enrolment success screen ends
                    on, at badge size. It says the face and the document were
                    accepted, which is what earned this account its passcode. */}
                <div style={{ marginTop: rem(4) }}>
                    <Icon name="kyc/verified" size={24} alt="" />
                </div>

                {name ? (
                    <p
                        className="fz-22 leading-none font-medium text-[#1D1D1D]"
                        style={{ marginTop: rem(6) }}
                    >
                        {name}
                    </p>
                ) : null}

                <p
                    className="fz-13 leading-none font-bold text-[#1D1D1D]"
                    style={{ marginTop: rem(22) }}
                >
                    {t('prompt')}
                </p>

                <div style={{ marginTop: rem(13) }}>
                    <PasscodeBoxes
                        key={round}
                        length={length}
                        variant="passcode"
                        mask
                        success={phase === 'success'}
                        error={phase === 'error'}
                        onInput={clearError}
                        // Lets a passkey be offered in this field's autofill
                        // bar, which is the one route to Face ID that skips
                        // Safari's confirmation sheet. See PasskeyUnlock.
                        passkeyAutofill={passkey !== undefined}
                        /*
                         * Hands focus to the PASSKEY when there is one.
                         *
                         * ⚠️ On a phone, focus means the keyboard, and the
                         * passkey prompt opens on the same mount — so the
                         * keyboard slid up and was shoved straight back down by
                         * the prompt, furniture flying in and out before anyone
                         * had decided anything.
                         *
                         * Nothing is lost: this row IS the input, laid over the
                         * boxes, so tapping it focuses and the keyboard arrives
                         * then — when somebody has chosen to type instead.
                         */
                        autoFocus={!passkeyEnrolled}
                        onFilled={start}
                        onComplete={(value) => void submit(value)}
                        // The row reports when its verdict has finished
                        // playing; the lock dismisses then, and not on a timer
                        // guessed against it. See `settle`.
                        onSettled={settle}
                    />
                </div>

                {/*
                  The way out for someone who cannot recall it.
                  ⚠️ It SIGNS OUT. There is no recovery to offer — nothing here
                  can tell a forgotten passcode from a stranger holding an
                  unlocked laptop, and the two must not be given different
                  answers. Signing out costs the real administrator one sign-in
                  and costs the stranger everything.
                */}
                {/*
          The button and its refusal share one relative box: the message hangs
          BELOW the button without occupying layout, so a wrong passcode does
          not shove the whole stack up 24 pixels and put every measured offset
          out — least of all at the moment somebody is being asked to look at
          the row again.
        */}
                <div className="relative flex flex-col items-center">
                    <p
                        onClick={() => {
                            // ⚠️ Sign out FIRST, then forget. `onSignOut` is also
                            // what tells the container this browser is leaving (see
                            // PasscodeLock); clearing the passcode before it is told
                            // would leave a moment where "no passcode" reads as "go
                            // and choose one", and the redirect that follows races
                            // the sign-out. Both are synchronous, so the order is
                            // the whole guarantee.
                            onSignOut();
                            sweepLegacyStorage();
                        }}
                        className="fz-12 focus:cursor-pointer leading-none font-medium text-[#484A48]"
                        style={{ marginTop: rem(13) }}
                    >
                        {t('forgot')}
                    </p>

                    {/*
                      Inside this box, BEFORE the refusal: the refusal hangs
                      `absolute top-full`, so it lands under whatever is last in
                      here. With the passkey outside, a message like "wrong"
                      was drawn straight over "Set Up A Passkey".
                    */}
                    {/*
                      The passkey, under the passcode — and on a device that has
                      already enrolled one it is not really "under" anything: the
                      platform prompt opens as this screen does, so the usual way in
                      is a face rather than six digits. The row above stays as the
                      way in when that fails or was never set up.

                      ⚠️ It renders nothing at all on a device that cannot offer
                      one, which includes every LAN address — WebAuthn needs a real
                      domain for the RP ID, so this is `localhost` or the deployed
                      host only. See passkey.ts.
                    */}
                    {passkey ? (
                        <PasskeyUnlock
                            driver={passkey}
                            name={name}
                            onUnlocked={onUnlocked}
                            armed={armed}
                            onArm={() => setArmed(true)}
                            deviceHasPasskey={deviceHasPasskey}
                            enrolOptions={enrolOptions}
                            onEnrolFailed={() => {
                                // The "finish" tap's prompt failed too. Same as
                                // above: not let in — disarm and back to the row.
                                setArmed(false);
                                setEnrolOptions(null);
                                fail(t('passkeyFailed'));
                            }}
                        />
                    ) : null}

                    {/* The refusal. It rises in rather than appearing, so a second wrong
              entry re-announces itself instead of sitting there looking like
              the same message. */}
                    <AnimatePresence initial={false}>
                        {error ? (
                            <motion.span
                                role="alert"
                                className="absolute top-full fz-10 leading-none font-medium whitespace-nowrap text-[#FF3B30]"
                                style={{ marginTop: rem(12) }}
                                variants={lineSwap}
                                initial={reduce ? 'still' : 'enter'}
                                animate="still"
                                exit={reduce ? 'still' : 'leave'}
                                transition={iosEase}
                            >
                                {error}
                            </motion.span>
                        ) : null}
                    </AnimatePresence>
                </div>


                <FlexSpace size={353} share={1} />
            </motion.div>
        </div>
    );
}

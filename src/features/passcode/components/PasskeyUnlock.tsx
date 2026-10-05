'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { iosEase } from '@/components/motion/presets';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import {
    hasLocalPasskey,
    isAutofillAvailable,
    isPasskeyOffered,
    passkeyKind,
    passkeyLabel,
    type PasskeyDriver,
    type PasskeyKind,
    type PasskeyOutcome,
} from '../passkey';
import { waitForSplash } from '@/features/splash/timing';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/** The glyph each platform's prompt is about to show. */
const GLYPH: Record<PasskeyKind, string> = {
    face: 'auth/face_id',
    fingerprint: 'auth/fingerprint',
    passkey: 'auth/passkey',
};

type State =
    /** Still working out whether this device can offer one. */
    | 'asking'
    /** It cannot — nothing is rendered. */
    | 'none'
    /** None bound on this device: offer Add device. */
    | 'enrol'
    /** Enrolled, and the prompt is open (or about to be). */
    | 'unlocking'
    /** Enrolled, but the prompt was dismissed — offer it as a button. */
    | 'retry';

/**
 * The passkey way in, under the passcode — Face ID, Touch ID, a fingerprint, or
 * Windows Hello, whichever this device has.
 *
 * ── The two halves behave completely differently, by design ─────────────────
 *
 *   FIRST TIME   an explicit control the person presses. Enrolling a credential
 *                shows the browser's own "save a passkey?" dialog and requires
 *                a real click behind it — browsers insist, and so would I: a
 *                site that could silently enrol a credential on somebody's
 *                device would be a worse thing than any convenience it bought.
 *
 *   EVERY TIME   nothing is asked and nothing is pressed. The prompt opens as
 *   AFTER        the lock appears, so the screen is "there is my face, and I am
 *                back in". The button is not the feature; the ABSENCE of the
 *                button is the feature, and it is the whole point of the
 *                request this was built for.
 *
 * ── Why a button still exists on the second path ────────────────────────────
 * Because the automatic attempt is allowed to fail and routinely does. A
 * dismissed prompt, a browser that wanted a user gesture and did not get one
 * (Safari, sometimes), a face that did not match — all arrive here as the same
 * "dismissed", deliberately indistinguishable so that a site cannot probe for
 * whether a credential exists. With no fallback, any of them would leave a
 * screen advertising a passkey that cannot be reached. So it retreats to a
 * button, and the passcode above it never stopped working.
 *
 * ── Server-verified ─────────────────────────────────────────────────────────
 * Every ceremony runs on the backend's options and is verified there — which
 * endpoints is the `driver`'s business (see `PasskeyDriver`). This component
 * owns only when to ask and what to show.
 *
 * ── Setting one up takes the PIN, and the device prompt follows ─────────────
 * Binding a passkey is behind the PIN (`/v1/me/device/options`). "Set Up Face
 * ID" ARMS the row (`onArm`): the next PIN typed opens a registration instead
 * of unlocking, and the gate starts the device prompt as soon as it answers,
 * on that keystroke's activation. Only a browser that refuses for lack of a
 * fresh gesture hands this control the options (`enrolOptions`) — it then
 * becomes "finish", whose tap is the activation `create()` wants.
 */
export function PasskeyUnlock({
    driver,
    name,
    onUnlocked,
    armed,
    onArm,
    enrolOptions,
    onEnrolFailed,
    deviceHasPasskey = false,
}: {
    driver: PasskeyDriver;
    /** Labels the credential in the device's own passkey list. Display only. */
    name?: string;
    onUnlocked: () => void;
    /** The gate is sending the next PIN to `driver.enrol` (owned by the gate). */
    armed: boolean;
    /** Setup was pressed: the gate should send the next PIN to `driver.enrol`. */
    onArm: () => void;
    /** The "finish" tap's prompt failed — the gate disarms and clears the row. */
    onEnrolFailed: () => void;
    /** The registration options, once the PIN opened one. */
    enrolOptions: Record<string, unknown> | null;
    /**
     * A setup found this device already holds the passkey (owned by the gate).
     * The control stops offering setup and offers "use this device" instead.
     */
    deviceHasPasskey?: boolean;
}) {
    const t = useTranslations('passcode');
    const [state, setState] = useState<State>('asking');
    /** The last attempt was refused — see `press`. Cleared by trying again. */
    const [failed, setFailed] = useState(false);
    const reduce = useReducedMotion();
    const kind = passkeyKind();

    /**
     * The ceremony currently open, so the next one can close it first.
     *
     * ⚠️ THIS IS WHY THE ICON DID NOTHING AFTER A REFUSAL. Turning the sheet
     * down leaves a CONDITIONAL request running — that is the whole point of
     * it, waiting quietly for the keyboard suggestion — and a browser permits
     * one outstanding WebAuthn request at a time. Tapping the icon started a
     * second, the browser refused it out of hand, and the refusal arrived as
     * the same "dismissed" any cancellation gives: the label went red and
     * nothing opened. Every subsequent tap did the same, because the request
     * blocking them was still sitting there.
     *
     * So every ceremony goes through here, and every one begins by aborting
     * whatever was already in flight.
     */
    const inFlight = useRef<AbortController | null>(null);

    async function ceremony(
        mediation: CredentialMediationRequirement,
        requireLocal = true,
    ): Promise<PasskeyOutcome> {
        inFlight.current?.abort();
        const cancel = new AbortController();
        inFlight.current = cancel;
        try {
            return await driver.authenticate(cancel.signal, mediation, requireLocal);
        } finally {
            // Only clear it if nothing newer has taken over in the meantime.
            if (inFlight.current === cancel) inFlight.current = null;
        }
    }

    /**
     * The automatic attempt, once per mount.
     *
     * ⚠️ THERE WAS A `tried` REF HERE AND IT MADE THE CONTROL VANISH. React
     * runs effects twice in development, and the guard was a ref — which
     * survives the simulated remount, unlike the state it was guarding. The
     * order that produced the bug:
     *
     *   run 1 starts, awaits    ·  cleanup fires, marking run 1 dead
     *   run 2 starts, awaits    ·  run 1 resumes and sets tried = true
     *   run 2 resumes, sees tried, and RETURNS
     *
     * Nothing then moved `state` off "asking", which renders null — so on any
     * device with a passkey already enrolled, the control was simply absent,
     * most visibly on re-locking. The guard was pointless as well as harmful:
     * the dependency list is empty, so this cannot re-fire on a re-render, and
     * re-firing per MOUNT is the intended behaviour.
     *
     * What the ceremony actually needs is cancellation, which is what the
     * AbortController below provides: cleanup aborts the in-flight prompt, so
     * the abandoned run's dialog closes instead of sitting on screen under the
     * live one's.
     */
    useEffect(() => {
        let live = true;

        void (async () => {
            if (!(await isPasskeyOffered(driver.rpId))) {
                if (live) setState('none');
                return;
            }
            // Nothing bound — or bound, but never on THIS device: offer setup
            // where binding is possible, else stay out of the way. Opening a
            // prompt here would only get Chrome's "passkey from another
            // device" QR code. (A match on the server's list is checked again
            // inside `authenticate`, for a device that holds a different
            // account's passkey.)
            if (!driver.bound) {
                if (live) setState(driver.enrol ? 'enrol' : 'none');
                return;
            }
            /*
             * Bound — but to the LINK, not necessarily to this device. With no
             * record of a passkey used here, this is a new device: offer Add
             * device and nothing else. "Use this device" would open a prompt
             * for a passkey that lives on the old device, and the browser's
             * answer to that is a QR code to scan with it — the wrong road for
             * somebody who should simply set this device up.
             */
            if (!hasLocalPasskey()) {
                if (live) setState(driver.enrol ? 'enrol' : 'none');
                return;
            }

            /*
             * ── NOT UNTIL THE SPLASH IS GONE ────────────────────────────────
             *
             * The splash is a `fixed` overlay and nothing more: this component
             * mounts and runs underneath it. So the passkey sheet was opening
             * ON TOP of the splash — Face ID asking about a screen nobody had
             * seen yet, over an animation still playing.
             *
             * `waitForSplash()` exists for precisely this; the camera
             * permission prompt hit it first (see splash/timing.ts). It
             * resolves immediately when no splash is playing, which is every
             * lock that is not a fresh page load.
             */
            await waitForSplash();
            if (!live) return;

            /*
             * ── ENROLLED MEANS DEFAULT ──────────────────────────────────────
             *
             * A device with a passkey is asked for the passkey, immediately and
             * without being asked to ask: the prompt opens as the lock appears,
             * and the six boxes are what is there if you would rather type.
             *
             * ⚠️ This was briefly the other way round — a conditional request
             * waiting silently for somebody to notice a suggestion above the
             * keyboard — and it was worse in the way that matters: it made the
             * passkey INVISIBLE. Nothing happened when the lock opened, and the
             * only route was spotting a small icon and tapping it, which is the
             * opposite of a default. Conditional avoids Safari's consent sheet
             * and that is genuinely nice, but it cannot be the primary path if
             * the primary path has to announce itself.
             *
             * ⚠️ Safari allows ONE gesture-free get() per navigation, so this
             * works on the page load that brings up the lock — the case that
             * matters — and may need the icon after an in-page re-lock.
             */
            if (live) setState('unlocking');
            const startedAt = performance.now();
            const outcome = await ceremony('optional');
            if (!live) return;
            /*
             * The elapsed time is the tell, and it is the only one available.
             *
             * A refusal and a dismissal are the SAME outcome by design — a site
             * may not learn whether a credential exists — so "dismissed" covers
             * both "they tapped Cancel" and "the browser would not open it at
             * all". The clock separates them: a human takes hundreds of
             * milliseconds to read a sheet and decide, a refusal comes back
             * almost instantly.
             *
             * If this reports a few milliseconds, the automatic prompt never
             * appeared — Safari grants one gesture-free get() per navigation
             * and this call is several seconds late, behind the splash. The
             * icon is the recovery, and a tap on it carries the activation the
             * automatic call lacked.
             */
            const ms = Math.round(performance.now() - startedAt);
            console.info(
                `[passkey] prompt on open: ${outcome} after ${ms}ms` +
                    (outcome !== 'ok' && ms < 250
                        ? ' — too fast to have been shown; the browser refused it'
                        : ''),
            );
            if (outcome === 'ok') {
                onUnlocked();
                return;
            }
            // No ceremony opened: the link's passkeys are not ones this browser
            // has used (or the server offered none). Same as above — Add
            // device, never a QR code.
            if (outcome === 'unavailable') {
                setState(driver.enrol ? 'enrol' : 'none');
                return;
            }

            /*
             * Dismissed. Now offer the QUIET route as well as the icon.
             *
             * Having turned the sheet down once, somebody is unlikely to want
             * it thrown up again — but they may well still want the passkey.
             * Conditional mediation puts it in the keyboard's own suggestion
             * bar, where taking it goes straight to Face ID with no second
             * sheet, because that tap happens in the browser's UI rather than
             * ours. It shows nothing of its own, so it costs nothing to leave
             * running underneath the icon.
             *
             * ⚠️ It needs the passcode field to carry `autocomplete="… webauthn"`
             * — `passkeyAutofill` on <PasscodeBoxes>, which the gate sets.
             * Without that there is nowhere to show the offer and this resolves
             * to nothing, silently.
             */
            setState('retry');
            if (!(await isAutofillAvailable())) return;
            const offered = await ceremony('conditional');
            if (!live) return;
            console.info(`[passkey] autofill offer: ${offered}`);
            if (offered === 'ok') onUnlocked();
        })();

        return () => {
            live = false;
            inFlight.current?.abort();
        };
        // `onUnlocked` is deliberately absent: it is a fresh closure on every
        // render of the gate, and including it would restart the ceremony each
        // time. The value it closes over (dismissing the lock) does not change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * What is rendered: `state`, except that a device found to hold the
     * passkey already is never offered setup again — derived rather than set
     * from an effect, so there is one source for it.
     */
    const shown: State = deviceHasPasskey && state === 'enrol' ? 'retry' : state;

    async function press() {
        // Setup, second tap: the PIN opened a registration and this click is
        // the activation `create()` requires.
        if (enrolOptions && driver.enrol) {
            const outcome = await driver.enrol.finish(enrolOptions, passkeyLabel(name));
            if (outcome === 'ok') {
                onUnlocked();
                return;
            }
            // Already on this device (another browser made it): use it, on
            // this same tap, instead of a setup that can never succeed.
            if (outcome === 'exists') {
                onEnrolFailed();
                await unlockWithThisDevice();
                return;
            }
            // NOT let in: the PIN only opened the registration — the accepted
            // credential is what signs in or unlocks. The reason is in the
            // console (see `runRegistration`); the gate disarms and the row is
            // the way on.
            onEnrolFailed();
            return;
        }

        // Setup, first tap: arm the row. The next PIN goes to `driver.enrol`.
        if (shown === 'enrol') {
            if (!armed) onArm();
            return;
        }

        await unlockWithThisDevice();
    }

    /**
     * The icon, tapped — only ever shown on a device that has used one of the
     * link's passkeys, so the local check is skipped: the person chose it.
     * Through `ceremony`, which cancels the conditional request left running
     * by an earlier refusal — without that, the browser refuses this one as a
     * duplicate and the tap appears to do nothing at all.
     */
    async function unlockWithThisDevice() {
        setState('unlocking');
        const outcome = await ceremony('optional', false);
        if (outcome === 'ok') {
            onUnlocked();
            return;
        }
        setFailed(true);
        setState('retry');
    }

    // Nothing this device can do. No message: a lock screen is not the place to
    // explain what a browser lacks, and the passcode above is unaffected.
    if (shown === 'asking' || shown === 'none') return null;

    /**
     * ── Words are for the SETUP only ────────────────────────────────────────
     * "Set Up A Passkey" has to be said, once: it is an offer, and an unlabelled
     * glyph is not an offer anybody will take. After that the control is the
     * icon alone — by then it is a familiar thing in a familiar place, and
     * "Unlock With Passkey" under a Face ID mark is a caption on something that
     * needs none.
     *
     * The icon carries the difference in SIZE. Beside text it is text-sized, or
     * it dominates the words; alone it has to be a target and a signal at once,
     * so it more than doubles. Same glyph, two jobs.
     */
    const confirming = enrolOptions !== null;
    const setup = shown === 'enrol' || confirming;

    /**
     * While the platform prompt is open the icon BEATS.
     *
     * There is nothing to say at that moment: the device has taken over the
     * screen with its own dialog, and a line of our text under it was competing
     * with the real instruction — which is the phone's, not ours. A pulse says
     * "waiting" without claiming a second voice.
     */
    const waiting = shown === 'unlocking';

    const label = failed
        ? t('passkeyFailed')
        : confirming
          ? t(`passkeyFinish.${kind}`)
          : armed
            ? t('passkeyArm')
            : t(`passkeySetup.${kind}`);

    return (
        <motion.p
            onClick={() => {
                setFailed(false);
                void press();
            }}
            /*
             * The name survives the words going away.
             *
             * Without a caption this control is a shape with a tap handler:
             * nothing announces it, nothing appears on hover, and "unlock with
             * your face" is not a thing to leave people guessing at. The
             * `passkeyUse` strings still exist for exactly this — they stopped
             * being shown, not being needed.
             */
            aria-label={setup ? undefined : t(`passkeyUse.${kind}`)}
            title={setup ? undefined : t(`passkeyUse.${kind}`)}
            className={cn(
                'fz-12 flex cursor-pointer items-center justify-center gap-8 leading-none font-medium',
                failed ? 'text-[#FF3B30]' : 'text-[#388CFF]',
            )}
            style={{ marginTop: rem(16) }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={iosEase}
        >
            {/* Text-sized beside the words, and much larger without them — see
                `setup`. Alone it is the whole control, so it has to be a target
                as well as a sign.

                It breathes while the device's own prompt is open.
                `repeat: Infinity` with a mirrored reverse, so it grows and
                shrinks on one continuous motion rather than snapping back to
                the start of each loop. */}
            <motion.span
                className="inline-flex"
                animate={waiting && !reduce ? { scale: [1, 1.25] } : { scale: 1 }}
                transition={
                    waiting && !reduce
                        ? {
                              duration: 0.7,
                              repeat: Infinity,
                              repeatType: 'reverse',
                              ease: 'easeInOut',
                          }
                        : iosEase
                }
            >
                <Icon name={GLYPH[kind]} size={setup ? 13 : 32} mask />
            </motion.span>

            {/* Only the offer is captioned. */}
            {setup ? <span>{label}</span> : null}
        </motion.p>
    );
}

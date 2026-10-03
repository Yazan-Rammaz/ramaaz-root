'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
    boxShut,
    CHECK_DRAW_S,
    checkDraw,
    glyphSwap,
    iosEaseFast,
    tapPop,
} from '@/components/motion/presets';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';

/**
 * Segmented code entry for OTP / passcode screens. A single hidden input
 * captures digits; the boxes are display-only and navigate to `nextHref` on
 * completion. Each box is 60×60, radius 15, 0.5px border.
 *
 * variant "otp" (verification / set passcode):
 *   empty → white bg + #388CFF dashed; filled → #FCFCFC bg + #C3C3C3 dashed.
 * variant "passcode" (enter passcode):
 *   empty → white bg + #C3C3C3 dashed; focused box → #388CFF dashed;
 *   filled → #FCFCFC bg + #4D84FF solid.
 *
 *   - mask: filled boxes show the lock glyph instead of the digit (passcodes).
 *
 * ── Waiting, and being written into, look different on purpose ──────────────
 * The box that will take the next digit is marked with a DOT in its middle. It
 * does not grow and it is not otherwise emphasised: it is waiting, and waiting
 * is a quiet state — a box held permanently large while somebody thinks about
 * their passcode makes the row restless, and it spends the emphasis before
 * anything has happened.
 *
 * Growing belongs to the box SHUTTING. A digit lands, shows in the clear with
 * its frame at full weight, and then the box pops as the lock takes its place —
 * one movement, not a grow followed later by a swap the box took no part in. So
 * size means "this just closed" and never "something might happen here", and
 * the dot and the pop are never on screen at once.
 *
 * ⚠️ NOTHING IS ADDED TO THE DRAWING. The frame that lights up is the EXISTING
 * dashed one — the 0.5 hairline going to 1 and back. No halo, no ring, no new
 * colour: a glow or a spread shadow on a rounded box IS a second frame, and the
 * lit box ended up wearing two, an outer solid one around the dashed one it was
 * supposed to be emphasising.
 */
/**
 * How long a freshly typed digit stays readable before the lock covers it.
 *
 * Long enough to read back what you typed, short enough that a shoulder is not
 * handed the whole passcode. Note what it is NOT tied to: this is per DIGIT,
 * reset by the next keystroke, so the value never sits in the clear for longer
 * than this no matter how slowly it is typed.
 */
const REVEAL_MS = 300;

/**
 * How long the box is held in its "closing" state — just long enough for the
 * pop keyframe to play out. It only has to outlast `tapPop`; it is a window for
 * an animation, not a duration anyone sees as itself.
 */
const CLOSE_MS = 240;

/**
 * The last box must finish shutting before the row reports a full value.
 *
 * ⚠️ THIS IS A CORRECTNESS FIX, not a flourish. `onComplete` used to fire on
 * the keystroke, so the verdict — "those didn't match", a red row, a shake —
 * landed on top of the sixth digit still sitting in the clear mid-animation.
 * The person was told the answer to a question the screen had not finished
 * asking, and the box appeared to be refused before it had closed.
 *
 * So completion waits out the digit and the pop that covers it. What follows is
 * then free to take the row over from a settled state.
 *
 * Unmasked rows report immediately: nothing is covering anything, so there is
 * no animation to outlast.
 */
const SETTLE_MS = REVEAL_MS + CLOSE_MS;

/**
 * The playback after a refusal: each digit uncovered in turn, first to last.
 *
 * A row that only shakes says "wrong" and nothing else — and the one thing
 * somebody needs after a mismatch is to see WHAT they typed, because the answer
 * is almost always a digit they know is not what they meant. Masking protects a
 * passcode that is being ACCEPTED; there is nothing left to protect about one
 * that has just been thrown away.
 *
 * In order rather than all at once: six digits appearing together is a number
 * to re-read, one after another is the sequence being replayed, which is how it
 * was entered and how it is remembered.
 */
const REPLAY_STEP_MS = 110;

/**
 * How long the whole entry stays readable once the last digit has appeared.
 *
 * ⚠️ WITHOUT THIS THE PLAYBACK IS POINTLESS. The row used to settle the instant
 * the sixth digit uncovered, so the complete number existed on screen for a
 * single frame before the boxes cleared and the screen went back — the digits
 * arrived one by one and then all vanished together, which reads as a glitch
 * rather than as an answer. The playback exists to be READ, and six digits take
 * about this long to read and compare against the one you meant.
 */
const REPLAY_HOLD_MS = 800;

/**
 * Checkmarks drawn one box at a time — and STRICTLY one at a time.
 *
 * ⚠️ This is the draw duration itself, not a rhythm chosen to look right. Each
 * mark starts exactly as the one before it finishes, so a single stroke travels
 * the row. Any smaller and two boxes are being drawn at once, which is what a
 * faster step produced: it reads as a wave washing over the row rather than as
 * the row being checked off, and the eye has nowhere particular to be.
 *
 * Derived from `CHECK_DRAW_S` rather than written out, so the two cannot drift.
 */
const CHECK_STEP_MS = CHECK_DRAW_S * 1000;

/**
 * ⚠️ MUST MATCH `.animate-shake` in globals.css (0.36s).
 *
 * The shake is CSS — it is a pure decoration on a class, and it predates any of
 * this — but the playback that follows it has to start when it STOPS, and only
 * JavaScript knows when that is. Two clocks, one duration; change one and the
 * digits start uncovering under a row that is still moving.
 */
const SHAKE_MS = 360;

type Props = {
    length?: number;
    /** Navigate here on completion (used when there's no onComplete handler). */
    nextHref?: string;
    /**
     * The row is full — fired on the KEYSTROKE, before the last box has finished
     * closing over its digit.
     *
     * For work that should not wait on an animation: the request that checks or
     * stores this value. It goes out now and runs while the box shuts, so the two
     * overlap instead of queueing, and a 2s round trip costs 2s rather than 2s
     * plus the half second the row spends settling.
     *
     * ⚠️ NOT for showing the answer. Nothing is known yet — that is `onComplete`,
     * which fires once the row is settled and is where a verdict may safely land.
     */
    onFilled?: (value: string) => void;
    /**
     * Called with the full value once the row has SETTLED — the last digit shown
     * and covered. Overrides nextHref navigation.
     */
    onComplete?: (value: string) => void;
    variant?: 'otp' | 'passcode';
    mask?: boolean;
    /** Show all filled boxes with a green (matched) border. */
    success?: boolean;
    /**
     * Wrong code: red border on every box plus a shake. The value is kept while
     * this shows so the boxes stay full during the animation — the caller
     * clears them afterwards by bumping `key`, which also refocuses the first
     * box on the fresh mount.
     */
    error?: boolean;
    /** Fired on every keystroke — lets the caller dismiss a stale error. */
    onInput?: () => void;
    /**
     * Let a passkey be offered in this field's autofill bar.
     *
     * ⚠️ THIS IS WHAT REMOVES SAFARI'S "USE PASSKEY" SHEET, and it is the only
     * thing that does. Conditional mediation needs a focused field carrying the
     * `webauthn` autocomplete token — that field is where the browser puts the
     * suggestion, and choosing it there goes straight to Face ID, because the tap
     * happened in the browser's own UI. Without the token there is nowhere for
     * the offer to appear and the request silently does nothing.
     *
     * Off by default: a row collecting a one-time code from a message has no
     * passkey to offer and should not advertise one.
     */
    passkeyAutofill?: boolean;
    /**
     * Take focus on mount. On by default — typing is what this is for.
     *
     * ⚠️ TURN IT OFF WHEN SOMETHING ELSE OPENS ON MOUNT. On a phone, focus means
     * the keyboard, and the keyboard is half the screen: with a passkey prompt
     * opening at the same moment, it slid up and was immediately shoved back down
     * by the sheet, so the lock screen began with a piece of furniture flying in
     * and out for no reason. Nothing was typed, and nothing was going to be.
     *
     * The row stays perfectly usable — it IS the input, laid over the boxes, so
     * tapping it focuses and the keyboard arrives then, when somebody has
     * actually chosen to type.
     */
    autoFocus?: boolean;
    /**
     * The row has finished playing the verdict it was given — the last digit
     * uncovered after a refusal, or the last checkmark fully drawn after a match.
     *
     * ⚠️ THIS IS WHAT A CALLER SHOULD MOVE ON FROM. The screens used to hold for
     * a constant tuned by hand against the cascade's length, which is two clocks
     * for one event: shorten a step here and the dashboard arrives over a row
     * still drawing itself. The row is the only thing that knows when it is done,
     * so it says so.
     */
    onSettled?: () => void;
};

export function PasscodeBoxes({
    length = 6,
    nextHref,
    onFilled,
    onComplete,
    variant = 'otp',
    mask = false,
    success = false,
    error = false,
    onInput,
    passkeyAutofill = false,
    autoFocus = true,
    onSettled,
}: Props) {
    const [value, setValue] = useState('');
    const [focused, setFocused] = useState(false);
    /**
     * Which box is showing its digit in the clear, if any.
     *
     * A masked entry that never shows anything gives no feedback that the RIGHT
     * key landed — only that something did. Showing the digit for a moment and
     * then hiding it is the compromise every phone lock screen makes: long
     * enough to catch your own typo, short enough that a passcode is not left
     * sitting on screen.
     *
     * One index, not a set: only the most recent digit is ever in the clear, so
     * a fast typist never leaves a trail of readable digits behind them.
     */
    const [reveal, setReveal] = useState<number | null>(null);
    const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * Which box is CLOSING over its digit right now.
     *
     * The pop is here rather than on the keystroke because the enlarge and the
     * digit-becoming-a-lock are one event: the box shuts. Fired when the digit
     * lands, the two ran in sequence — grow, settle, wait, then a swap the box
     * took no part in — and the swap read as happening to the box rather than
     * being done by it.
     */
    const [closing, setClosing] = useState<number | null>(null);
    const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * How far the after-the-fact cascades have got: the digits played back
     * after a refusal, and the checkmarks drawn after a match.
     *
     * ONE counter for both, because they are the same movement — left to right,
     * one box per tick — and only one of them can ever be running: `error` and
     * `success` are mutually exclusive outcomes of the same entry.
     */
    const [cascade, setCascade] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const reduce = useReducedMotion();
    // Completion must fire exactly ONCE per fill. Extra keystrokes while the
    // handler is in flight used to re-trigger onComplete with the same value —
    // duplicate requests that burned the backend's 5/min throttle. The parent
    // clears the boxes by remounting (key bump), which resets this too.
    const completedRef = useRef(false);
    const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const router = useRouter();
    /**
     * Held in a ref so the cascade effect does not restart when the caller passes
     * a fresh closure — which it does on every render, and restarting the effect
     * would start the whole verdict over from the first box.
     */
    const onSettledRef = useRef(onSettled);
    // Kept current AFTER render, not during it (react-hooks/refs). The cascade
    // only reads it from its interval, which never runs before this does.
    useEffect(() => {
        onSettledRef.current = onSettled;
    });

    useEffect(() => {
        if (!autoFocus) return;
        inputRef.current?.focus({ preventScroll: true });
    }, [autoFocus]);

    // The row is unmounted mid-entry all the time — a wrong code remounts it, a
    // step change replaces it, the lock is dismissed outright. A digit must not
    // be left in the clear by a timer firing into a gone component.
    useEffect(() => {
        return () => {
            if (revealTimer.current) clearTimeout(revealTimer.current);
            if (closingTimer.current) clearTimeout(closingTimer.current);
            // ⚠️ Including the pending completion. A row unmounted during the
            // settle (the lock dismissed, the step abandoned) must not report a
            // value out of a component that no longer exists.
            if (completeTimer.current) clearTimeout(completeTimer.current);
        };
    }, []);

    /**
     * The verdict cascade — play the digits back, or draw the checkmarks.
     *
     * An interval rather than six timeouts so the whole thing is cancelled by
     * one cleanup, and so a verdict arriving while another is still running
     * (possible only through a caller bug, but cheap to be safe about) cannot
     * leave two cascades interleaving down the same row.
     *
     * ⚠️ `setCascade` is called from the interval CALLBACK, never in the effect
     * body. That is the difference between subscribing to something and
     * cascading renders, and it is what `react-hooks/set-state-in-effect` is
     * pointing at (AGENTS.md §10 — that rule is an error everywhere but the
     * ported KYC screens).
     */
    useEffect(() => {
        // Nothing to cascade. No reset needed either: both verdicts end in the
        // caller remounting this row (a key bump to clear it, or the screen
        // moving on), which resets `cascade` for free.
        if (!error && !success) return;

        let stepper: ReturnType<typeof setInterval> | undefined;
        const step = error ? REPLAY_STEP_MS : CHECK_STEP_MS;
        // A refusal shakes FIRST and plays back second. Reading six digits off
        // a row that is still moving is exactly the moment not to ask someone
        // to read anything.
        const lead = error ? SHAKE_MS : 0;

        const begin = setTimeout(() => {
            // The FIRST box goes now, not one interval from now. A leading
            // tick costs a whole step of dead air at the front — 200ms of
            // green row with nothing happening in it, which is long enough
            // to read as the screen having stalled at the moment it is
            // meant to be confirming.
            setCascade(1);
            stepper = setInterval(() => {
                setCascade((n) => (n >= length ? n : n + 1));
            }, step);
        }, lead);

        /**
         * When the row has FINISHED saying what it has to say.
         *
         * Box i starts at `lead + i * step`.
         *
         *   match    a checkmark takes exactly one step to draw (see
         *            CHECK_STEP_MS), so the last lands a full step after it starts.
         *   refusal  a digit is simply uncovered, so the last is done the moment it
         *            appears — and then the whole number is HELD, so it can be read
         *            before the row clears. See REPLAY_HOLD_MS.
         *
         * ⚠️ This is what the CALLER waits on before moving — it is not a
         * decoration. Anything that navigates or clears the row on its own timer is
         * guessing at this number from the outside, and guessing short truncates
         * the confirmation somebody is being shown.
         */
        const total = error ? lead + (length - 1) * step + REPLAY_HOLD_MS : length * step;
        const finish = setTimeout(() => {
            clearInterval(stepper);
            onSettledRef.current?.();
        }, total);

        return () => {
            clearTimeout(begin);
            clearTimeout(finish);
            clearInterval(stepper);
        };
    }, [error, success, length]);

    function onChange(e: React.ChangeEvent<HTMLInputElement>) {
        if (completedRef.current) return;
        const next = e.target.value.replace(/\D/g, '').slice(0, length);
        // Typing again dismisses a stale error message.
        onInput?.();
        setValue(next);

        // Show the digit that just landed, and only while it is the newest.
        // A deletion reveals nothing — there is no new digit to confirm, and
        // uncovering an older one would be backwards.
        if (revealTimer.current) clearTimeout(revealTimer.current);
        if (next.length > value.length) {
            const landed = next.length - 1;
            setReveal(landed);
            revealTimer.current = setTimeout(() => {
                // The box shuts: the digit becomes a lock and the box pops, on
                // the same tick. See `closing`.
                setReveal(null);
                setClosing(landed);
                if (closingTimer.current) clearTimeout(closingTimer.current);
                closingTimer.current = setTimeout(() => setClosing(null), CLOSE_MS);
            }, REVEAL_MS);
        } else {
            setReveal(null);
        }

        if (next.length === length) {
            // Claimed NOW, not when the report fires — the row is complete from
            // this keystroke, and anything typed during the settle must not be
            // able to start a second completion. (See `completedRef`: duplicate
            // reports once burned the backend's throttle.)
            completedRef.current = true;

            // Straight away, before the box has shut — see `onFilled`. Whatever this
            // starts runs alongside the animation rather than behind it.
            onFilled?.(next);

            const report = () => {
                if (onComplete) onComplete(next);
                else if (nextHref) router.push(nextHref);
            };

            // Let the last box finish shutting before anyone is told anything.
            // See SETTLE_MS — the verdict used to land on top of a digit still
            // animating.
            if (mask) {
                completeTimer.current = setTimeout(report, SETTLE_MS);
            } else {
                report();
            }
        }
    }

    return (
        <div
            className="relative"
            onMouseDown={(e) => {
                e.preventDefault();
                inputRef.current?.focus();
            }}
        >
            {/*
        ⚠️ `cn`, NOT a template literal. This was
        `` `flex gap-6${error ? " animate-shake" : ""}` ``, and the leading
        space inside the branch is load-bearing — a formatter pass took it out
        and the class silently became `gap-6animate-shake`, one token that
        matches nothing. Nothing errors, nothing warns, the row just stops
        shaking. Class names must never be built by string concatenation here.
      */}
            <div className={cn('flex gap-6', error && 'animate-shake')}>
                {Array.from({ length }).map((_, i) => {
                    const filled = i < value.length;
                    const isActive = focused && i === value.length;
                    /**
                     * Played back after a refusal: this box's digit has been
                     * uncovered and stays uncovered until the row is cleared.
                     * Unlike `reveal`, these accumulate — the whole entry ends
                     * up readable, which is the point of showing it at all.
                     */
                    const replayed = error && i < cascade;
                    /** Drawn after a match, left to right. */
                    const checked = success && i < cascade;
                    /**
                     * The digit is in the clear here — because it just landed,
                     * because this row was never masking in the first place (an
                     * OTP the person is meant to read back), or because the
                     * entry was refused and is being played back.
                     */
                    const showDigit = filled && (!mask || reveal === i || replayed);
                    /**
                     * This box is holding its digit in the clear — so its
                     * frame is at full weight for as long as that lasts. The
                     * GROWING is not here; it belongs to `closing`, the moment
                     * the digit becomes a lock.
                     */
                    const writing = reveal === i;
                    /**
                     * Waiting for the next digit — the dot, and nothing else.
                     *
                     * Suppressed while any box is revealing: for that moment the
                     * attention belongs to the digit that just landed, and a dot
                     * already pointing at the next box would be hurrying someone
                     * past the one thing on screen worth reading.
                     */
                    const waiting = isActive && reveal === null;

                    let stroke: string;
                    let fill: string;
                    let dashed: boolean;
                    if (error) {
                        // Every box, not just the filled ones — the whole entry
                        // was rejected, not one digit.
                        stroke = '#FF3B30';
                        fill = '#FCFCFC';
                        dashed = false;
                    } else if (success && filled) {
                        // Matched. The dash STAYS — this is the same box in a
                        // finished state, not a different kind of box, and the
                        // XD frame ("Set Passcode Done") keeps it dashed and
                        // fills it mint. A solid ring here read as a fourth
                        // border style nothing else in the flow uses.
                        stroke = '#34C759';
                        fill = '#E0FFEE';
                        dashed = true;
                    } else if (variant === 'passcode') {
                        if (filled) {
                            stroke = '#4D84FF';
                            fill = '#FCFCFC';
                            dashed = false;
                        } else if (isActive) {
                            stroke = '#388CFF';
                            fill = '#FFFFFF';
                            dashed = true;
                        } else {
                            stroke = '#C3C3C3';
                            fill = '#FFFFFF';
                            dashed = true;
                        }
                    } else if (filled) {
                        stroke = '#C3C3C3';
                        fill = '#FCFCFC';
                        dashed = true;
                    } else {
                        stroke = '#388CFF';
                        fill = '#FFFFFF';
                        dashed = true;
                    }

                    return (
                        <PasscodeBox
                            key={i}
                            digit={filled ? value[i] : null}
                            showDigit={showDigit}
                            hideGlyph={success}
                            writing={writing}
                            waiting={waiting}
                            checked={checked}
                            popping={closing === i}
                            stroke={stroke}
                            fill={fill}
                            dashed={dashed}
                            reduce={Boolean(reduce)}
                        />
                    );
                })}
            </div>

            <input
                ref={inputRef}
                value={value}
                onChange={onChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                inputMode="numeric"
                /*
                 * ⚠️ "username webauthn", NOT "one-time-code webauthn".
                 *
                 * The `webauthn` token is only honoured alongside the autofill names
                 * browsers actually associate with credentials — `username` and
                 * `current-password`. Appended to `one-time-code` it parses, warns
                 * about nothing, and is simply never acted on: no suggestion appears in
                 * the keyboard bar, the conditional request sits there waiting forever,
                 * and the only way in is the modal it exists to avoid. That is exactly
                 * the symptom it produced.
                 *
                 * `username` on a six-digit passcode field is a lie about the content,
                 * and a deliberate one: this input is off-screen and exists only to
                 * collect keystrokes, nothing reads the token as a description, and it
                 * is the string that makes the passkey offer appear at all.
                 */
                autoComplete={'one-time-code'}
                aria-label="Code"
                className="absolute inset-0 h-full w-full cursor-default opacity-0 outline-none"
            />
        </div>
    );
}

/**
 * ONE box. Memoised, and that is the whole reason it is a separate component.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Typing felt laggy, and the cause was structural rather than any one animation
 * being expensive. Every keystroke re-rendered all six boxes inline, and each
 * carried a `motion.div`, a `motion.rect` and an `<AnimatePresence>` whose
 * `animate`/`transition`/`variants` objects were built fresh on that render —
 * so Motion re-read roughly twenty animated values per keystroke to discover
 * that eighteen of them had not changed, while the mask-image spans inside
 * unaffected boxes churned along with them.
 *
 * A keystroke genuinely changes TWO boxes: the one that just took a digit, and
 * the one that had the dot. Memoised on primitives, that is now all that
 * renders — the other four are skipped before Motion is involved at all.
 *
 * ⚠️ EVERY PROP HERE MUST STAY A PRIMITIVE. Pass an object or an inline
 * callback and `memo` compares by identity, every box re-renders again, and the
 * lag comes back with nothing visibly different about the code.
 */
type BoxProps = {
    /** The character to show, or null when this box is empty. */
    digit: string | null;
    /** Show the digit rather than the lock. */
    showDigit: boolean;
    /** Show neither — the row matched and the checkmarks are taking over. */
    hideGlyph: boolean;
    /** Holding its digit in the clear: frame at full weight. */
    writing: boolean;
    /** Next to be typed into: the dot. */
    waiting: boolean;
    /** Draw this box's checkmark. */
    checked: boolean;
    /** Play the shut animation now. */
    popping: boolean;
    stroke: string;
    fill: string;
    dashed: boolean;
    reduce: boolean;
};

const PasscodeBox = memo(function PasscodeBox({
    digit,
    showDigit,
    hideGlyph,
    writing,
    waiting,
    checked,
    popping,
    stroke,
    fill,
    dashed,
    reduce,
}: BoxProps) {
    const filled = digit !== null;

    return (
        <motion.div
            className="relative h-60 w-60"
            /*
             * ⚠️ NO SECOND RING. An earlier version haloed the
             * lit box with a spread box-shadow, and a spread
             * shadow on a rounded box IS a frame — so the lit
             * box had two, an outer solid one around the dashed
             * one it was meant to be emphasising.
             *
             * What lights up is the frame that is already
             * there: the rect's own stroke thickens below, and
             * the box lifts. Nothing is added to the drawing.
             */
            /*
             * Enlarge AND return, in one keyframe — the box
             * does not stay big. Holding the new size would
             * leave the last box typed permanently larger than
             * its neighbours until the next keystroke moved the
             * distortion along the row.
             *
             * Keyed to `closing`, so it plays on the same tick
             * as the digit turning into the lock: one movement,
             * the box shutting over what was typed.
             */
            animate={{
                scale: popping && !reduce ? [1, 1.08, 1] : 1,
            }}
            transition={tapPop}
        >
            <svg
                aria-hidden
                className="absolute inset-0 h-full w-full"
                viewBox="0 0 60 60"
                preserveAspectRatio="none"
            >
                <motion.rect
                    x="0.25"
                    y="0.25"
                    width="59.5"
                    height="59.5"
                    rx="14.75"
                    fill={fill}
                    stroke={stroke}
                    /*
                     * The whole "lit" treatment, in one number.
                     * Same frame, same dash, same colour — just
                     * drawn at full weight instead of hairline
                     * while this is the box being typed into.
                     *
                     * In viewBox units, which are XD pixels
                     * here (60x60 box, 60 units), so this is
                     * the 0.5px hairline going to 1px and back.
                     */
                    /*
                     * The flash is THIS rect's own fill pulsing
                     * — the box brightening in the colour it
                     * already is.
                     *
                     * ⚠️ It was a white rect laid over the fill,
                     * and white is a colour this row does not
                     * own: on the green frame it washed the mint
                     * out to paper for a moment, so the box
                     * changed colour twice (mint → white → mint)
                     * while the tick was being drawn across it.
                     * Dipping the fill's own opacity instead
                     * brightens it toward the page behind
                     * without introducing anything, and works
                     * unchanged whatever the fill happens to be.
                     */
                    animate={{
                        strokeWidth: writing ? 1 : 0.5,
                        fillOpacity: checked && !reduce ? [1, 0.35, 1] : 1,
                    }}
                    transition={{
                        strokeWidth: iosEaseFast,
                        fillOpacity: checkDraw,
                    }}
                    strokeDasharray={dashed ? '3 3' : undefined}
                />

                {/*
                                  ── The checkmark is DRAWN, not shown ────────
                                  `pathLength` 0 → 1, so the stroke is laid down
                                  from the short arm to the long one, the way a
                                  tick is actually made. A finished glyph that
                                  fades in is an announcement; one that is drawn
                                  is the row working through the entry it just
                                  accepted, which is what the cascade is for.

                                  ⚠️ Inline SVG, which pages may not do — icons
                                  come from `<Icon>` (AGENTS.md §5). `<Icon>`
                                  renders an `<img>`, and nothing inside an
                                  `<img>` can be animated, so a drawn stroke is
                                  not expressible that way. It joins the rect
                                  above, which is inline for the same kind of
                                  reason: this component draws its own box.
                                */}
                {checked ? (
                    <motion.path
                        /*
                         * Coordinates are viewBox units = XD
                         * pixels, so this mark is 16 wide and
                         * 11.5 tall, centred on (30, 30) in the
                         * 60 box. It was 24 x 16.5 and filled
                         * the box corner to corner, which read
                         * as a tick stamped OVER the box rather
                         * than one sitting inside it — the same
                         * inset every other glyph here has.
                         */
                        d="M22 30.5 L27.5 36 L38 24.5"
                        fill="none"
                        stroke="#34C759"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={reduce ? false : { pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={checkDraw}
                    />
                ) : null}
            </svg>

            <div className="relative flex h-full w-full items-center justify-center fz-24 font-medium text-ink">
                {/*
                                  The digit, then the lock that replaces it.

                                  ⚠️ NO `mode="wait"`, deliberately, and it was
                                  wrong here for a while. `wait` holds the
                                  incoming glyph until the outgoing one has
                                  finished leaving, so the swap ran end to end
                                  inside a box that had already popped and
                                  settled — the box flashed, and THEN the digit
                                  turned into a lock. They are one event and
                                  have to overlap: `boxShut` gives the swap the
                                  same length as `tapPop`, so both start and end
                                  together. The glyphs are absolutely positioned
                                  below, which is what makes overlapping them
                                  free of layout.

                                  `initial` is left ON so a digit POPS as it
                                  lands — that arrival is the whole feedback for
                                  a keystroke that otherwise shows nothing.
                                */}
                <AnimatePresence>
                    {/*
                                      On a match the locks GO — all of them, the
                                      moment the row turns green — and the
                                      checkmarks are then drawn into empty
                                      boxes. Retiring each lock only as its own
                                      tick arrived left the row half locked and
                                      half ticked all the way down, which reads
                                      as a row still deciding rather than one
                                      that has already said yes.
                                    */}
                    {filled && !hideGlyph ? (
                        <motion.span
                            key={showDigit ? 'digit' : 'lock'}
                            // Absolute so the outgoing digit
                            // and the arriving lock occupy the
                            // same spot for the moment they
                            // overlap, instead of sitting side
                            // by side and shunting the box's
                            // contents off centre.
                            className="absolute inset-0 flex items-center justify-center"
                            variants={glyphSwap}
                            initial={reduce ? 'still' : 'enter'}
                            animate="still"
                            exit={reduce ? 'still' : 'leave'}
                            transition={boxShut}
                        >
                            {showDigit ? (
                                digit
                            ) : (
                                <Icon
                                    name="auth/pin_lock"
                                    width={16}
                                    height={24}
                                    mask
                                    className="text-[#388CFF]"
                                />
                            )}
                        </motion.span>
                    ) : waiting ? (
                        /*
                                          The caret, as a dot.
                                          Its colour is the box's own stroke, so
                                          it is the frame's mark rather than a
                                          new element with an opinion — and it
                                          follows the palette into every state
                                          without being told.
                                        */
                        <motion.span
                            key="dot"
                            aria-hidden
                            // Centred by its own box rather
                            // than by the flex parent, for the
                            // same reason the glyphs are: it
                            // overlaps whatever it is replacing.
                            className="absolute top-1/2 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{ backgroundColor: stroke }}
                            variants={glyphSwap}
                            initial={reduce ? 'still' : 'enter'}
                            animate="still"
                            exit={reduce ? 'still' : 'leave'}
                            transition={iosEaseFast}
                        />
                    ) : null}
                </AnimatePresence>
            </div>
        </motion.div>
    );
});

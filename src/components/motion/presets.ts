import type { Transition, Variants } from "motion/react";

/**
 * The single iOS-flavored motion vocabulary. Every animation in the app pulls
 * from here so timing/feel stay uniform. Don't inline ad-hoc springs.
 */

/** UIKit-like spring — for cards, sheets, shared-element transitions. */
export const iosSpring: Transition = {
  type: "spring",
  stiffness: 320,
  damping: 32,
  mass: 0.9,
};

/** iOS navigation easing curve (the classic push/pop cubic). */
export const iosEase: Transition = {
  duration: 0.35,
  ease: [0.32, 0.72, 0, 1],
};

/**
 * The same curve, at keystroke speed.
 *
 * `iosEase` is tuned for a SCREEN arriving — at that scale 0.35s reads as
 * smooth. Put it on something that answers a single keypress and it reads as
 * lag, because the next keypress is already coming and the last one is still
 * moving. Anything that fires once per character belongs here.
 */
export const iosEaseFast: Transition = {
  duration: 0.11,
  ease: [0.32, 0.72, 0, 1],
};

/**
 * Seconds one mark takes to draw.
 *
 * Exported as a NUMBER because a caller drawing a row of them one after another
 * has to step at exactly this rate — see `CHECK_STEP_MS` in `PasscodeBoxes`.
 * Two independent constants would look identical and drift on the first tweak,
 * and the symptom of drift is subtle: marks that overlap slightly, or a gap
 * between them, neither of which looks like a bug so much as a bad rhythm.
 */
export const CHECK_DRAW_S = 0.12;

/**
 * A mark being drawn — for `pathLength: 0 → 1` on an SVG stroke.
 *
 * `easeOut` rather than the navigation curve: a stroke laid down by hand starts
 * at speed and settles at the end, and the ease is most of what separates "a
 * tick is being drawn" from "a tick is wiping into view".
 */
export const checkDraw: Transition = {
  duration: CHECK_DRAW_S,
  ease: "easeOut",
};

/**
 * ⚠️ ONE LENGTH, TWO TRANSITIONS — `tapPop` and `boxShut` must stay equal.
 *
 * A box closing over a typed digit is ONE event seen two ways: the box pops,
 * and what is inside it becomes a lock. They have to start together and finish
 * together or the eye reads them as cause and effect — box flashes, and then,
 * separately, the contents change.
 */
const SHUT_S = 0.22;

/**
 * Enlarge and return — a control acknowledging ONE keystroke.
 *
 * For a `scale: [1, n, 1]` keyframe. `times` front-loads the growth so the
 * expansion is quick and the settle is the longer half, which is what makes it
 * read as a press being answered rather than as a pulse.
 */
export const tapPop: Transition = {
  duration: SHUT_S,
  times: [0, 0.35, 1],
  ease: [0.32, 0.72, 0, 1],
};

/**
 * The glyph swap that runs INSIDE that pop — same length, no `times` (it drives
 * plain two-value tweens rather than a keyframe array).
 *
 * ⚠️ Use it with an `<AnimatePresence>` that has NO `mode`. `mode="wait"` is the
 * right default for a swap that must not overlap, and it is exactly wrong here:
 * it holds the incoming glyph back until the outgoing one has gone, so the two
 * halves run end to end and the lock lands after the box has already settled.
 * The children must be absolutely positioned so that overlapping them costs no
 * layout.
 */
export const boxShut: Transition = {
  duration: SHUT_S,
  ease: [0.32, 0.72, 0, 1],
};

/** Page push — content slides in like a navigation controller. */
export const pagePush: Variants = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24 },
};

/**
 * One glyph replaced by another inside a box it shares — a typed digit becoming
 * the lock that hides it.
 *
 * It grows in and leaves by growing FURTHER, rather than reversing: the outgoing
 * glyph reads as receding past the viewer while the incoming one arrives, which
 * is what makes the pair look like one thing changing state instead of two
 * things trading places. Use with `mode="wait"` — the box is 60 XD px and two
 * glyphs in it at once is a smudge.
 *
 * ⚠️ The travel is deliberately SMALL. This fires on every keystroke and it
 * runs twice per change (out, then in), so a wide scale range turns six digits
 * into six little explosions — the swap was 0.4 → 1.6 and read as the row
 * showing off rather than as a digit being covered. Just enough to see that
 * something was replaced.
 */
export const glyphSwap: Variants = {
  enter: { opacity: 0, scale: 0.75 },
  still: { opacity: 1, scale: 1 },
  leave: { opacity: 0, scale: 1.2 },
};

/**
 * One STEP replaced by the next, as a navigation push — the whole screen
 * travels, so the new step reads as somewhere you arrived at rather than as the
 * old one with its words changed.
 *
 * The direction comes from `custom` on both `<AnimatePresence>` and the
 * `<motion.*>` element: `1` goes forward (in from the end, out to the start),
 * `-1` comes back. Pair it with `mode="wait"` so one screen is gone before the
 * next arrives — the same shape `VerificationPage` uses between KYC steps, and
 * the reason this lives here rather than being written out a second time.
 *
 * ⚠️ The travel is `x`, which is PHYSICAL, so an RTL locale pushes the same way
 * an LTR one does. That matches every other transition in the app today
 * (`template.tsx`, `VerificationPage`); if it is ever made logical, it has to
 * be made logical in all three at once or the app will push two ways at the
 * same time.
 */
export const stepPush: Variants = {
  enter: (direction: number) => ({ x: `${direction * 100}%`, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: `${direction * -100}%`, opacity: 0 }),
};

/**
 * One line of text replaced by another, in place — rises in, leaves upward.
 *
 * For a label that CHANGES rather than a block that appears: the step label
 * under a code row, a heading that becomes its own past tense. Pair it with
 * `<AnimatePresence mode="wait">` so the outgoing line is gone before the
 * incoming one arrives — two lines crossfading through each other at small
 * sizes is unreadable.
 *
 * The states are named rather than initial/animate/exit because both ends
 * collapse to `still` under reduced motion, and "still" is what that means.
 */
export const lineSwap: Variants = {
  enter: { opacity: 0, y: 8 },
  still: { opacity: 1, y: 0 },
  leave: { opacity: 0, y: -8 },
};

/** Card/sheet open — scale + lift, iOS modal feel. */
export const cardOpen: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 12 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 8 },
};

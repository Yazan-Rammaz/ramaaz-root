"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { FlexSpace } from "@/components/ui/FlexSpace";
import { cn } from "@/lib/utils/cn";
import { iosEase, lineSwap, stepPush } from "@/components/motion/presets";
import { PasscodeBoxes } from "@/features/auth/components/PasscodeBoxes";
import { useCodeFeedback } from "@/features/auth/use-code-feedback";
import { setDocumentUnlocked } from "@/features/auth/lock-flag";
import { PASSCODE_LENGTH } from "../schema";
import type { PasscodeVerdict } from "./PasscodeLockGate";

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * ── The mint is the PAGE, not the column ────────────────────────────────────
 * These screens are drawn on the 430 canvas, so the route wraps them in
 * `<Screen maxW={430}>` and anything wider than that is letterbox. Painted on
 * the screen's own box, the colour stopped at the column's edge and the frame
 * read as a mint card on white.
 *
 * `fixed inset-0` escapes the column and covers the viewport — one declaration,
 * owned by the screen that knows its colour, and it works the same in the
 * design gallery, which mounts this component inside the wrapper the route
 * uses. (Handing the background to the route instead would be the hex written
 * in two places, and the gallery entry is exactly the copy that drifts.)
 *
 * `-z-10` keeps it under everything painted after it, including the `(auth)`
 * layout's brand mark. It cannot fall behind the page itself: the body's
 * background is propagated to the canvas, which is below every stacking
 * context.
 */
function PageTint() {
  return <div aria-hidden className="fixed inset-0 -z-10 bg-[#F4FFF4]" />;
}

/**
 * The last step of a first sign-in: choose a passcode, then type it again.
 *
 * Rendered by /login/pass-code when the backend's `PASS_CODE_REQUIRED` step
 * says `pass_code_mode: SET`. The two entries are compared HERE; only the
 * agreed value is sent, once, through `save`.
 *
 * ── Two pages, ONE component ────────────────────────────────────────────────
 * The second entry is a page: it pushes in the way every other step of this
 * sign-in does, and a mismatch pushes back. Only the label under the row
 * actually differs between them — the heading, the copy and the six boxes are
 * identical — and that is precisely why it has to travel. Swapping the label in
 * place left the row looking untouched at the moment a second, different thing
 * was being asked for.
 *
 * It is still ONE component, and that is not an inconsistency. Two ROUTES would
 * unmount the thing holding the first entry, leaving the second with nothing to
 * compare against; the first entry would have to be parked somewhere that
 * survives a navigation, which for a passcode means somewhere it should not be.
 * So the step is state, the transition is `stepPush`, and the comparison never
 * leaves this function.
 *
 * ── What each outcome does ──────────────────────────────────────────────────
 *   match     the row goes green, the heading becomes "Set Passcode Done", and
 *             the third line of copy drops away (frame 3). Held for a beat so
 *             the confirmation is actually seen, then the dashboard.
 *   mismatch  red, a shake, and back to the FIRST entry with both boxes
 *             cleared — not to a "try the confirmation again" state. Nothing
 *             was chosen, because the only evidence of what was meant is the
 *             two entries agreeing.
 *
 * ── It counts nothing ───────────────────────────────────────────────────────
 * A mismatch is not a failed attempt; there is no budget here to spend. Typing
 * two different things is a typo, and it may happen as often as it happens.
 */
export function SetPasscodeScreen({
  /**
   * Render the screen without letting it touch anything — for /design.
   *
   * The gallery mounts the REAL component (that is the point of the gallery),
   * and this one is unusual in that finishing it would otherwise send a PIN
   * and navigate away from the thing the reviewer came to look at. So in
   * preview a match stops at the green frame instead of saving anything.
   *
   * ⚠️ A REVIEW AFFORDANCE, never a mode. It must stay impossible to reach
   * from a route: nothing in `app/` passes it, and the real screen has no
   * branch that could set it.
   */
  preview = false,
  /**
   * Send the agreed PIN — `submitPassCodeAction` from the pass-code step.
   * Its refusal (a rate limit, say) is shown under the row and the screen goes
   * back to the first entry, since nothing was chosen.
   */
  save,
  /** Digits in the PIN — the backend's `pass_code_length`. */
  length = PASSCODE_LENGTH,
}: {
  preview?: boolean;
  save?: (code: string) => Promise<PasscodeVerdict>;
  length?: number;
} = {}) {
  const t = useTranslations("passcode");
  const router = useRouter();
  const reduce = useReducedMotion();
  const { phase, error, round, fail, succeed, settle, clearError } =
    useCodeFeedback();
  const [step, setStep] = useState<"set" | "reenter">("set");
  /**
   * Which way the step change travels: 1 forward, -1 back.
   *
   * Both moves this screen makes are real navigation — on to the
   * confirmation, or back to the start after a mismatch — so they must not
   * look alike. A mismatch that pushed forward would read as progress at the
   * exact moment nothing was accepted.
   */
  const [direction, setDirection] = useState(1);
  /**
   * The first entry, waiting for the second to agree with it.
   *
   * A ref, not state: nothing renders from it, and it must survive the
   * remount that clearing the boxes causes — which is exactly what state
   * would be reset by. It is cleared on every outcome, so the value never
   * outlives the entry it belongs to.
   */
  const first = useRef<string | null>(null);

  const done = phase === "success";

  /**
   * The save, in flight.
   *
   * ── Started on the keystroke, applied once the row has settled ───────────
   * `save` is a request, and a request has no business waiting for an
   * animation. The
   * moment the confirmation entry is full AND matches, it goes out — while the
   * last box is still closing over its digit. Run in sequence the round trip
   * would start half a second late, and the screen would sit on a finished
   * animation waiting for a call it had not made yet.
   *
   * A ref, not state: nothing renders from it, and a re-render between starting
   * the save and reading it must not drop the promise.
   */
  const saving = useRef<Promise<PasscodeVerdict> | null>(null);

  function send(value: string): Promise<PasscodeVerdict> {
    return (saving.current = save ? save(value) : Promise.resolve({ ok: true }));
  }

  /**
   * The row is full. Decide whether there is anything to send, and send it.
   *
   * ⚠️ The comparison happens HERE as well as in `handleComplete`, and that is
   * the price of starting the request early: whether this value is worth saving
   * is exactly the question the mismatch check asks, and it has to be answered
   * before the animation rather than after it. The two must agree — they are
   * the same expression, deliberately identical.
   */
  function handleFilled(value: string) {
    if (preview) return;
    if (step !== "reenter" || value !== first.current) return;
    send(value);
  }

  async function handleComplete(value: string) {
    if (step === "set") {
      first.current = value;
      setDirection(1);
      setStep("reenter");
      return;
    }

    if (value !== first.current) {
      first.current = null;
      // Back to the first entry once the shake has finished — see `fail`.
      // The screen travels BACKWARDS to get there; nothing was accepted.
      fail(t("mismatch"), () => {
        setDirection(-1);
        setStep("set");
      });
      return;
    }

    first.current = null;

    // The gallery stops at the confirmation — nothing stored, nowhere to go.
    if (preview) {
      succeed(() => {});
      return;
    }

    // Normally already in flight from `onFilled`; started here only if that
    // never ran, so the passcode cannot be silently not-saved.
    const verdict = await (saving.current ?? send(value));
    saving.current = null;

    // Refused — nothing was chosen, so back to the first entry, the same way
    // a mismatch goes.
    if (!verdict.ok) {
      fail(verdict.error, () => {
        setDirection(-1);
        setStep("set");
      });
      return;
    }

    // It was just typed, twice. Demanding it again on the dashboard this
    // navigation lands on would be absurd — see lock-flag.ts.
    setDocumentUnlocked(true);
    succeed(() => router.replace("/dashboard"));
  }


  return (
    // `overflow-hidden` because the step below travels a full screen width
    // to arrive. Without it the outgoing step is briefly a horizontal
    // scrollbar.
    <div className="h-full overflow-hidden">
      <PageTint />

      {/*
              ── The second entry is a PAGE, not a relabelled first one ───────
              Typing the passcode again is a step, and it is drawn as its own
              frame in XD, so it arrives the way every other step in this
              sign-in arrives: the screen pushes. Swapping the label in place
              (what this did first) made the most consequential moment on the
              screen a word changing under a row that never moved — it was
              genuinely easy to miss that anything had been asked.

              `mode="wait"`, so the first entry is gone before the second
              arrives. Overlapping two identical rows of boxes mid-slide reads
              as one row duplicating itself. `custom` carries the direction —
              forward to the confirmation, back on a mismatch. `initial={false}`
              so ARRIVING at this screen does not push: the route transition
              already did that.

              Keyed on `step` alone. The success state is NOT a new page — it
              is this page confirming itself, so the heading and the row change
              in place and the screen stays put.
            */}
      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          className="flex h-full flex-col"
          variants={stepPush}
          initial={reduce ? "center" : "enter"}
          animate="center"
          exit={reduce ? "center" : "exit"}
          transition={iosEase}
        >
          {/*
              ⚠️ THE FOOT IS A MEASURED GAP, NOT LEFTOVER. Read this before
              changing any of the three spacers on this screen.

              The frame is 288 above the heading, 122 between the copy and the
              row, and 343 below the label — the three gaps the XD file
              actually names. The foot was a
              `<FlexSpace grow>` first, which is the obvious way to end a
              full-height screen and is wrong here: `grow` takes whatever is
              left AFTER two fixed gaps, so the design's proportions only held
              at 932. On the laptop canvas (768) that left 175 under the label
              instead of a scaled 343, and the whole screen sat high.

              All three carry their XD size and a share, so the shortfall is
              distributed across them in proportion to what the frame gave each
              — the screen keeps its shape at every height rather than keeping
              its head and losing its foot. See FlexSpace on why the shares
              must sum to at least 1 (three at 1 clears that with room).
            */}
          <FlexSpace size={288} share={1} />

          {/* The copy block is inset from the frame's edge; the row of boxes
                below is centred on the full canvas and therefore wider than
                this inset. Two containers rather than one padded column. */}
          <div className="flex flex-col items-start px-40 text-start">
            {/*
                  The heading CHANGES at the end — "Set Passcode !" becomes
                  "Set Passcode Done" — and swapping the text in place makes the
                  most important moment of the screen the least visible one.
                  `mode="wait"` so one line is gone before the other arrives;
                  two headings crossfading through each other is unreadable at
                  this size.
                */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.h1
                key={done ? "done" : "set"}
                className="fz-32 leading-none font-bold text-[#1D1D1D]"
                variants={lineSwap}
                initial={reduce ? "still" : "enter"}
                animate="still"
                exit={reduce ? "still" : "leave"}
                transition={iosEase}
              >
                {done ? t("doneTitle") : t("title")}
              </motion.h1>
            </AnimatePresence>

            <p
              className="fz-16 leading-none font-medium text-[#1D1D1D]"
              style={{ marginTop: rem(18) }}
            >
              {t("subtitle")}
            </p>

            {/*
              Gone on the finished frame — the reassurance is for someone
              deciding, and by then they have decided.

              ⚠️ IT FADES, IT DOES NOT UNMOUNT, and the difference is the whole
              screen. Removing it took 24 XD px of height out of a block that
              everything below is measured from, so the heading, the row and the
              label all jumped UP at the moment of success — the one frame that
              should be still. Mounted and transparent, it holds its own space
              and nothing moves.

              The XD frames agree: the title sits at the same offset on the
              "Done" frame as on the other two, with the third line simply
              absent rather than closed up.
            */}
            <motion.p
              aria-hidden={done}
              className="fz-12 leading-none font-normal text-[#484A48]"
              style={{ marginTop: rem(12) }}
              animate={{ opacity: done ? 0 : 1 }}
              transition={iosEase}
            >
              {t("reassurance")}
            </motion.p>
          </div>

          <FlexSpace size={122} share={1} />

          <div className="flex flex-col items-center">
            {/*
                  The row's own motion is the shake and the green — both about
                  the ENTRY. Travelling between steps is the page's job, one
                  level up, and this rides along with it.
                */}
            <PasscodeBoxes
              // Remounting is how the row is cleared AND refocused after
              // a mismatch. A STEP change remounts it too, via the keyed
              // page above — which is why `step` is not repeated here.
              key={round}
              length={length}
              mask
              success={done}
              error={phase === "error"}
              onInput={clearError}
              onFilled={handleFilled}
              onComplete={(value) => void handleComplete(value)}
              // The row says when its verdict has finished playing, and only
              // then does anything move: the dashboard on a match, the first
              // entry on a mismatch. See `settle`.
              onSettled={settle}
            />

            {/* What the row is being asked for. It arrives with its page,
                    so the only swap left here is the REFUSAL replacing it on a
                    mismatch and going again when the retry starts.

                    Absent on the finished frame: the row is green and the
                    heading says so, and a label still reading "Reenter
                    Passcode" under it would be asking for something already
                    given. */}
            {/* Fades on the finished frame rather than unmounting, for the
                same reason the reassurance line does — this row is what the
                foot of the screen is measured from. */}
            <motion.div
              aria-hidden={done}
              className="flex justify-center"
              style={{ marginTop: rem(14) }}
              animate={{ opacity: done ? 0 : 1 }}
              transition={iosEase}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={error ? "error" : step}
                  role={error ? "alert" : undefined}
                  className={cn(
                    "fz-12 leading-none font-medium",
                    error ? "text-[#FF3B30]" : "text-[#484A48]",
                  )}
                  variants={lineSwap}
                  initial={reduce ? "still" : "enter"}
                  animate="still"
                  exit={reduce ? "still" : "leave"}
                  transition={iosEase}
                >
                  {error ??
                    (step === "set" ? t("setLabel") : t("reenterLabel"))}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          </div>

          <FlexSpace size={343} share={1} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The shared feedback behaviour for segmented code entry — the OTP screen and
 * the passcode gate behave identically, so the state machine lives here once.
 *
 *   wrong  → red borders + shake, the entry played back, then the boxes clear
 *            and the first one refocuses. The MESSAGE stays up afterwards, so
 *            it can still be read; it is dismissed by starting to type again,
 *            or by requesting a new code.
 *   right  → green borders and the checkmarks drawn, then move on — so the
 *            confirmation is actually seen rather than flashing past.
 *
 * Clearing works by bumping `round`, which the caller passes as `key` to
 * <PasscodeBoxes>. Remounting resets its value AND refocuses, so there is no
 * separate "clear" path to keep in sync.
 *
 * ── What moves it on ────────────────────────────────────────────────────────
 * `settle()`, called by the row itself when it has finished playing the
 * verdict (`<PasscodeBoxes onSettled>`), NOT a duration guessed here.
 *
 * ⚠️ It used to be a pair of constants tuned by hand against what the row does
 * inside them — a shake plus six digits, or six checkmarks drawn end to end.
 * That is two clocks for one event, and they drift silently: shortening a step
 * in the row leaves the dashboard arriving over a row still drawing itself, and
 * nothing anywhere says so. The row is the only thing that knows when it is
 * done, so it is the thing that says when.
 */

/**
 * The backstop, and it should never be what fires.
 *
 * `settle()` is called from an animation the row schedules, and an animation
 * that never completes — a component that stops rendering mid-cascade, a caller
 * that forgets to wire `onSettled` — would otherwise leave somebody parked on a
 * green screen that never goes anywhere, with no way forward at all. Generous
 * enough that it cannot truncate a real cascade (the longest is ~1.2s), short
 * enough to be a recovery rather than a hang.
 */
const FALLBACK_MS = 4000;

export type CodePhase = "idle" | "success" | "error";

export function useCodeFeedback() {
  const [phase, setPhase] = useState<CodePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  /**
   * What happens once the row has finished. Held rather than scheduled, so the
   * ROW decides when it runs.
   *
   * A ref: nothing renders from it, and it must survive the re-renders the
   * verdict itself causes between being set and being run.
   */
  const pending = useRef<(() => void) | null>(null);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nothing should fire after unmount — the gate can be dismissed mid-verdict.
  useEffect(() => {
    return () => {
      if (fallback.current) clearTimeout(fallback.current);
      pending.current = null;
    };
  }, []);

  /**
   * The row has finished playing the verdict. Run whatever was waiting on it.
   *
   * Idempotent: the continuation is cleared as it is taken, so the backstop
   * firing after a real `onSettled` (or a row reporting twice) does nothing.
   */
  const settle = useCallback(() => {
    if (fallback.current) {
      clearTimeout(fallback.current);
      fallback.current = null;
    }
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);

  const arm = useCallback(
    (then: () => void) => {
      pending.current = then;
      if (fallback.current) clearTimeout(fallback.current);
      fallback.current = setTimeout(() => settle(), FALLBACK_MS);
    },
    [settle],
  );

  /**
   * Wrong code: shake, play the entry back, then clear and refocus.
   *
   * `then` runs at the END of all that, for a caller that has to undo more than
   * the boxes. Setting the passcode is the one that does: a mismatch sends it
   * back to the FIRST entry, and doing that the moment the mismatch is known
   * would swap the label out from under a row that is still showing somebody
   * what they typed.
   */
  const fail = useCallback(
    (message: string, then?: () => void) => {
      setError(message);
      setPhase("error");
      arm(() => {
        setPhase("idle");
        setRound((r) => r + 1);
        then?.();
      });
    },
    [arm],
  );

  /** Right code: hold the green state while the row confirms, then continue. */
  const succeed = useCallback(
    (then: () => void) => {
      setError(null);
      setPhase("success");
      arm(then);
    },
    [arm],
  );

  /** Typing again, or a fresh code was requested. */
  const clearError = useCallback(() => setError(null), []);

  return { phase, error, round, fail, succeed, settle, clearError };
}

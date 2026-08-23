"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The shared feedback behaviour for segmented code entry — the OTP screen and
 * the passcode gate behave identically, so the state machine lives here once.
 *
 *   wrong  → red borders + shake for SHAKE_MS, then the boxes clear and the
 *            first one refocuses. The MESSAGE stays up afterwards, so it can
 *            still be read; it is dismissed by starting to type again, or by
 *            requesting a new code.
 *   right  → green borders held for HOLD_MS before moving on, so the confirmation
 *            is actually seen rather than flashing past.
 *
 * Clearing works by bumping `round`, which the caller passes as `key` to
 * <PasscodeBoxes>. Remounting resets its value AND refocuses, so there is no
 * separate "clear" path to keep in sync.
 */
const SHAKE_MS = 1000;
const HOLD_MS = 1000;

export type CodePhase = "idle" | "success" | "error";

export function useCodeFeedback() {
  const [phase, setPhase] = useState<CodePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Nothing should fire after unmount — the gate can be dismissed mid-animation.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
    };
  }, []);

  const track = useCallback((t: ReturnType<typeof setTimeout>) => {
    timers.current.push(t);
  }, []);

  /** Wrong code: shake, then clear and refocus. Message persists. */
  const fail = useCallback(
    (message: string) => {
      setError(message);
      setPhase("error");
      track(
        setTimeout(() => {
          setPhase("idle");
          setRound((r) => r + 1);
        }, SHAKE_MS),
      );
    },
    [track],
  );

  /** Right code: hold the green state, then continue. */
  const succeed = useCallback(
    (then: () => void) => {
      setError(null);
      setPhase("success");
      track(setTimeout(then, HOLD_MS));
    },
    [track],
  );

  /** Typing again, or a fresh code was requested. */
  const clearError = useCallback(() => setError(null), []);

  return { phase, error, round, fail, succeed, clearError };
}

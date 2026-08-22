"use client";

import { useState } from "react";
import { PasscodeBoxes } from "./PasscodeBoxes";
import { setPasscodeAction } from "../actions";

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * First-login passcode: enter, then re-enter to confirm.
 *  - enter (label "Set Passcode") → store, switch to re-enter.
 *  - re-enter (label "Reenter Passcode"):
 *      match   → boxes turn green, passcode is stored via the Server Action,
 *                which starts the session and redirects to the dashboard.
 *      mismatch→ show an error message for 2s, then reset to the enter step.
 */
export function SetPasscodeFlow() {
  const [phase, setPhase] = useState<"enter" | "reenter">("enter");
  const [first, setFirst] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Bumping this remounts <PasscodeBoxes>, clearing it between steps.
  const [round, setRound] = useState(0);

  function reset(message: string | null) {
    setError(message);
    setTimeout(() => {
      setError(null);
      setPhase("enter");
      setFirst("");
      setRound((r) => r + 1);
    }, 2000);
  }

  async function handleComplete(value: string) {
    if (phase === "enter") {
      setFirst(value);
      setPhase("reenter");
      setRound((r) => r + 1);
      return;
    }
    if (value !== first) {
      reset("Passcode doesn’t match");
      return;
    }
    setSuccess(true);
    // Success redirects to the dashboard inside the action (303, the promise
    // settles with no value) — only a failure carries a result to show.
    const result = await setPasscodeAction(value);
    if (result?.error) {
      setSuccess(false);
      reset(result.error);
    }
  }

  return (
    <div className="flex flex-col items-center" style={{ marginTop: rem(40) }}>
      <PasscodeBoxes
        key={round}
        length={6}
        mask
        success={success}
        onComplete={handleComplete}
      />
      <span
        className={`fz-11 leading-none font-medium ${error ? "text-red-500" : "text-ink"}`}
        style={{ marginTop: rem(16) }}
      >
        {error ?? (phase === "enter" ? "Set Passcode" : "Reenter Passcode")}
      </span>
    </div>
  );
}

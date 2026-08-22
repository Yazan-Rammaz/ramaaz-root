"use client";

import { useState } from "react";
import { PasscodeBoxes } from "./PasscodeBoxes";
import { passcodeUnlockAction } from "../actions";
import { markUnlocked } from "@/lib/auth/lock-state";

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Returning-user passcode entry. The Server Action checks the passcode against
 * the backend (refresh cookie proves the device) and redirects to the
 * dashboard on success; a wrong passcode clears the boxes and shows the error.
 */
export function PasscodeUnlock() {
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  return (
    <div className="flex flex-col items-center">
      <PasscodeBoxes
        key={round}
        length={6}
        variant="passcode"
        mask
        onComplete={async (value) => {
          markUnlocked();
          const result = await passcodeUnlockAction(value);
          // Success redirects to the dashboard inside the action (the promise
          // settles with no value) — only a failure carries a result to show.
          if (result?.error) {
            setError(result.error);
            setRound((r) => r + 1);
          }
        }}
      />
      {error && (
        <span
          role="alert"
          className="fz-11 leading-none font-medium text-red-500"
          style={{ marginTop: rem(16) }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

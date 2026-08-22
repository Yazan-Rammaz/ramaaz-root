"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { PasscodeBoxes } from "./PasscodeBoxes";
import { passcodeUnlockAction, verifyPasscodeAction } from "../actions";

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * THE passcode screen — a gate, not a route.
 *
 * It is an overlay so the same component serves both places it is needed, and
 * so neither one has to navigate. Being a route was what produced the redirect
 * loop: the dashboard bounced to /login/passcode, which bounced back.
 *
 * Two modes, same UI, different outcomes:
 *
 *   "login"  the passcode IS the credential. It signs in via /v1/auth/login
 *            and the action redirects to wherever the admin belongs.
 *   "lock"   the session already exists; this only proves presence. Verifies
 *            and dismisses, leaving the admin on the page they were on.
 *
 * Tokens are never cleared by the lock — locking is a UI state, not a sign-out.
 */
export function PasscodeGate({
  mode,
  name,
  role,
  onUnlocked,
  onSignOut,
}: {
  mode: "login" | "lock";
  /** Display only; blank pre-session, where nothing identifies the admin yet. */
  name?: string;
  role?: string;
  /** Called after a successful unlock. `lock` mode only — `login` redirects. */
  onUnlocked?: () => void;
  /** Escape hatch for someone who cannot recall their passcode. */
  onSignOut?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    try {
      const result =
        mode === "lock"
          ? await verifyPasscodeAction(value)
          : // Success redirects inside the action, so the promise settles with
            // no value; only a failure returns something to show.
            await passcodeUnlockAction(value);

      if (result?.error) {
        setError(result.error);
        setRound((r) => r + 1);
        return;
      }
      if (mode === "lock") onUnlocked?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      // Opaque and fixed: in lock mode this covers whatever is behind it, so
      // nothing on the dashboard is readable while locked.
      className="bg-background fixed inset-0 z-40 flex h-full flex-col items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Enter your passcode"
    >
      <div className="flex h-45/100 items-end justify-center">
        <div className="bg-muted/40 h-200 w-200 overflow-hidden rad-15">
          <Icon
            name="side/avatar"
            width={200}
            height={200}
            className="h-full w-full object-cover"
          />
        </div>
      </div>

      <div className="flex h-55/100 flex-col items-center">
        {role ? (
          <span
            className="fz-18 text-ink leading-none font-bold"
            style={{ marginTop: rem(12) }}
          >
            {role}
          </span>
        ) : null}
        {name ? (
          <span
            className="fz-18 text-ink leading-none font-normal"
            style={{ marginTop: rem(6) }}
          >
            {name}
          </span>
        ) : null}

        <span
          className="fz-12 text-ink leading-none font-bold"
          style={{ marginTop: rem(20) }}
        >
          Enter Your Passcode
        </span>

        <div style={{ marginTop: rem(16) }}>
          <PasscodeBoxes
            key={round}
            length={6}
            variant="passcode"
            mask
            onComplete={submit}
          />
        </div>

        {error ? (
          <span
            role="alert"
            className="fz-11 leading-none font-medium text-red-500"
            style={{ marginTop: rem(16) }}
          >
            {error}
          </span>
        ) : null}

        {mode === "lock" && onSignOut ? (
          <button
            type="button"
            onClick={onSignOut}
            disabled={busy}
            className="fz-12 text-primary font-medium disabled:opacity-50"
            style={{ marginTop: rem(24) }}
          >
            Sign out instead
          </button>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { PasscodeBoxes } from "./PasscodeBoxes";
import {
  forgetDeviceAction,
  passcodeUnlockAction,
  verifyPasscodeAction,
} from "../actions";
import { setDocumentUnlocked } from "../lock-flag";
import { useCodeFeedback } from "../use-code-feedback";

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/** "super_admin" -> "SA". Initials only; the full role name is not shown. */
function roleAbbr(role?: string): string {
  return (role ?? "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

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
  const { phase, error, round, fail, succeed, clearError } = useCodeFeedback();
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    try {
      // Claimed BEFORE the call: in login mode the action redirects and never
      // returns, so there is no "after" in which to set it — and without it the
      // dashboard would open locked and ask for the passcode just entered.
      setDocumentUnlocked(true);

      const result =
        mode === "lock"
          ? await verifyPasscodeAction(value)
          : // Success redirects inside the action, so the promise settles with
            // no value; only a failure returns something to show.
            await passcodeUnlockAction(value);

      if (result?.error) {
        // Wrong passcode — the optimistic unlock above must be taken back, or
        // the lock would dismiss itself on the next remount.
        setDocumentUnlocked(false);
        fail(result.error);
        return;
      }
      // Hold the green state briefly so the confirmation is seen. In login mode
      // the action has already redirected, so only the lock reaches here.
      if (mode === "lock") succeed(() => onUnlocked?.());
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
            {roleAbbr(role)}
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
            success={phase === "success"}
            error={phase === "error"}
            onInput={clearError}
            onComplete={submit}
          />
        </div>

        {/* Centred under the boxes. Reserves its height so the layout does not
            jump when a message appears or clears. */}
        <span
          role="alert"
          className="fz-11 min-h-16 text-center leading-none font-medium text-red-500"
          style={{ marginTop: rem(16) }}
        >
          {error ?? ""}
        </span>

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

        {/* Sign-in mode: the way back to the private-code field. /login jumps
            straight here whenever a code is remembered, so without this a stale
            one — the admin was removed, or somebody else needs to sign in — is
            a dead end that only clearing cookies escapes. */}
        {mode === "login" ? (
          <button
            type="button"
            onClick={() => void forgetDeviceAction()}
            disabled={busy}
            className="fz-12 text-primary font-medium disabled:opacity-50"
            style={{ marginTop: rem(24) }}
          >
            Use a different private code
          </button>
        ) : null}
      </div>
    </div>
  );
}

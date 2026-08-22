"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PasscodeGate } from "./PasscodeGate";
import { logoutAction } from "../actions";

/**
 * Locks the protected area after a period of inactivity, and covers it with the
 * passcode gate until the admin proves they are still there.
 *
 * ── What this is and is not ─────────────────────────────────────────────────
 * It is a UX lock, for the case of walking away from an unattended screen. It
 * is NOT a security boundary: the session cookie stays valid throughout (that
 * is the point — locking must not sign anyone out), so anyone with devtools
 * and this browser could dismiss it. Every real rule stays server-side.
 *
 * Idle is measured from the last interaction, not from sign-in, so someone
 * working continuously is never interrupted.
 */
const IDLE_MS = 5 * 60 * 1000;

/** Interactions that count as "still here". */
const ACTIVITY = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

export function IdleLock({ name, role }: { name?: string; role?: string }) {
  const [locked, setLocked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLocked(true), IDLE_MS);
  }, []);

  useEffect(() => {
    if (locked) {
      // No point counting activity while the gate is up — typing the passcode
      // would otherwise keep resetting a timer that is already expired.
      if (timer.current) clearTimeout(timer.current);
      return;
    }

    arm();
    const onActivity = () => arm();
    for (const evt of ACTIVITY) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    // A backgrounded tab stops firing activity events; re-check on return so a
    // laptop closed for an hour comes back locked.
    const onVisible = () => {
      if (document.visibilityState === "visible") arm();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const evt of ACTIVITY) window.removeEventListener(evt, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [locked, arm]);

  if (!locked) return null;

  return (
    <PasscodeGate
      mode="lock"
      name={name}
      role={role}
      onUnlocked={() => setLocked(false)}
      onSignOut={() => void logoutAction()}
    />
  );
}

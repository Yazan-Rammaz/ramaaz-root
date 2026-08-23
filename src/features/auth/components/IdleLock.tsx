"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PasscodeGate } from "./PasscodeGate";
import { logoutAction } from "../actions";
import { isDocumentUnlocked, setDocumentUnlocked, LOCK_EVENT } from "../lock-flag";

/**
 * Keeps the protected area behind the passcode gate.
 *
 * It locks in two situations:
 *   - on every fresh page load, so arriving authenticated still means proving
 *     it is you before anything on the dashboard can be read, and
 *   - after 5 minutes without interaction, for the unattended screen.
 *
 * Idle is measured from the last interaction rather than from sign-in, so
 * someone working continuously is never interrupted.
 *
 * ── What this is and is not ─────────────────────────────────────────────────
 * A UX lock. NOT a security boundary: the session cookie stays valid
 * throughout — that is the point, locking must not sign anyone out — so
 * anyone with devtools and this browser could dismiss it. Every real rule
 * stays server-side.
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
  // Locked until proven otherwise. Server-renders `true`, and a genuine page
  // load has the flag unset, so hydration agrees.
  const [locked, setLocked] = useState(() => !isDocumentUnlocked());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDocumentUnlocked(false);
      setLocked(true);
    }, IDLE_MS);
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

    // Manual lock from the navbar.
    const onLockRequest = () => setLocked(true);
    window.addEventListener(LOCK_EVENT, onLockRequest);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const evt of ACTIVITY) window.removeEventListener(evt, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(LOCK_EVENT, onLockRequest);
    };
  }, [locked, arm]);

  if (!locked) return null;

  return (
    <PasscodeGate
      mode="lock"
      name={name}
      role={role}
      onUnlocked={() => {
        setDocumentUnlocked(true);
        setLocked(false);
      }}
      onSignOut={() => void logoutAction()}
    />
  );
}

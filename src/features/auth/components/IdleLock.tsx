"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
 *
 * ── The gate is injected ────────────────────────────────────────────────────
 * This component owns WHEN to lock and nothing about how to get back in. It
 * used to render the passcode gate directly; the passcode no longer exists, and
 * a face re-verify replaces it. Keeping the timer here and the challenge in the
 * caller means that swap costs one prop rather than a rewrite.
 *
 * ⚠️ Currently UNMOUNTED (see app/(dashboard)/layout.tsx) — the face re-verify
 * gate needs a session-authenticated face endpoint the backend does not expose
 * yet.
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

type Props = {
  /**
   * What covers the screen while locked. Given `onUnlocked` to call once the
   * admin has proven themselves, and `onSignOut` for the way out.
   */
  renderGate: (opts: { onUnlocked: () => void; onSignOut: () => void }) => ReactNode;
};

export function IdleLock({ renderGate }: Props) {
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
      // No point counting activity while the gate is up — proving yourself
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

  return renderGate({
    onUnlocked: () => {
      setDocumentUnlocked(true);
      setLocked(false);
    },
    onSignOut: () => void logoutAction(),
  });
}

"use client";

import { useEffect } from "react";
import { requestLock } from "./lock-flag";

/**
 * Raise the PIN lock when a Server Action answers `{ locked: true }`.
 *
 * That answer means the backend wanted the PIN before letting the session
 * continue, and the action never reached it (`SessionLockedError` in
 * lib/api/server.ts). Showing the lock is the honest response — "something
 * went wrong" was not — and since the overlay sits over the same document,
 * whatever was typed is still there to send again once it's dismissed.
 *
 * Pass the action state itself: a new answer is a new object, so a second
 * locked answer locks again.
 */
export function useLockWhenLocked(state: { locked?: boolean }) {
  useEffect(() => {
    if (state.locked) requestLock();
  }, [state]);
}

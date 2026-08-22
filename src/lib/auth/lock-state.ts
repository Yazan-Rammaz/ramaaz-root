/**
 * App-unlock flag — whether the passcode has been entered for this visit.
 *
 * Two requirements that pull against each other:
 *   1. a genuine page reload must RE-LOCK (the passcode is the point), and
 *   2. arriving on the dashboard from the sign-in flow must NOT re-lock.
 *
 * ── Why in-memory state cannot do this ──────────────────────────────────────
 * It was a module-scope `let unlocked = false`, then a `window` property. Both
 * failed the same way: signing in and landing on /dashboard is a FULL DOCUMENT
 * LOAD (the splash overlay re-appearing is the giveaway), and that wipes module
 * scope and `window` alike. The gate then read `false`, bounced back to the
 * passcode screen, and looped forever.
 *
 * (The earlier theory that webpack duplicated the module across chunks was
 * wrong — the emitted chunks share one module id, so there was only ever one
 * instance. The reload is what destroyed it.)
 *
 * ── What works ─────────────────────────────────────────────────────────────
 * sessionStorage survives the reload, so requirement 2 holds. Requirement 1 is
 * restored by asking the Navigation Timing API how this document was entered:
 * `type === "reload"` means the user actually refreshed, so the flag is
 * dropped and the passcode is asked for again. A redirect from the sign-in
 * flow reports "navigate" and keeps it.
 *
 * Scoped to the tab and cleared when it closes, which is the right lifetime.
 */
const KEY = "rdb_unlocked";

/** Storage can throw (private mode, blocked cookies); never break the gate. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function isUnlocked(): boolean {
  if (typeof window === "undefined") return false;
  return safe(() => sessionStorage.getItem(KEY) === "1", false);
}

export function markUnlocked(): void {
  if (typeof window === "undefined") return;
  safe(() => sessionStorage.setItem(KEY, "1"), undefined);
}

/**
 * Re-lock when this document was entered by an actual reload (F5, the browser's
 * reload button, location.reload()). Call once, before reading `isUnlocked()`.
 *
 * A redirect or link navigation reports "navigate" and is left alone — that is
 * what stops the sign-in → dashboard hop from re-locking.
 */
export function relockIfReloaded(): void {
  if (typeof window === "undefined") return;
  safe(() => {
    const [entry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    if (entry?.type === "reload") sessionStorage.removeItem(KEY);
  }, undefined);
}

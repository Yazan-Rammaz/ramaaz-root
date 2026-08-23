/**
 * "The passcode has been satisfied in THIS document."
 *
 * Read by <IdleLock>, which otherwise opens locked on every page load. Set by
 * the two places that already prove identity:
 *
 *   - finishing sign-in (the passcode was just chosen or entered), and
 *   - dismissing the lock itself.
 *
 * Without the first, completing sign-in would drop you on the dashboard and
 * immediately demand the same passcode you just typed.
 *
 * Stored on `window`: it survives the remounts a router-cache invalidation
 * causes (every Server Action that writes a cookie triggers one), and is wiped
 * by a genuine page load — which is exactly when the lock SHOULD return.
 * `window` rather than module scope so a module duplicated across chunks
 * cannot end up with two disagreeing copies.
 */
const FLAG = "__rdbDocUnlocked" as const;

type LockWindow = Window & { [FLAG]?: boolean };

export function isDocumentUnlocked(): boolean {
  if (typeof window === "undefined") return false;
  return (window as LockWindow)[FLAG] === true;
}

export function setDocumentUnlocked(value: boolean): void {
  if (typeof window === "undefined") return;
  (window as LockWindow)[FLAG] = value;
}

/**
 * Lock on demand, from the navbar's lock control.
 *
 * A window event rather than React state because the button (navbar) and the
 * gate (<IdleLock>, in the dashboard layout) are siblings — routing this
 * through a context provider would mean wrapping the shell just to pass one
 * boolean. Locking this way shows the passcode gate with NO splash: nothing
 * reloads, the document is the same one, only the overlay appears.
 */
export const LOCK_EVENT = "rdb:lock";

export function requestLock(): void {
  if (typeof window === "undefined") return;
  setDocumentUnlocked(false);
  window.dispatchEvent(new Event(LOCK_EVENT));
}

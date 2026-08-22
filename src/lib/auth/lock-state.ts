/**
 * App-unlock flag — whether the passcode has been entered for THIS page load.
 *
 * Requirements: false again after any full reload (so the passcode is
 * re-prompted), but preserved across client-side navigation.
 *
 * ── Why this is on `window` and not a module variable ───────────────────────
 * It used to be `let unlocked = false` at module scope. That breaks in a
 * production build: `markUnlocked()` is called from the passcode screen and
 * `isUnlocked()` from the dashboard layout — different route segments, so
 * different chunks — and a module this small can be duplicated into each chunk
 * instead of shared. The unlock then set one copy while the gate read another
 * that was still false, so the gate bounced back to the passcode screen
 * immediately, forever. It only showed up deployed, because `next dev` has a
 * single module graph and no chunk splitting.
 *
 * `window` is one object per document, so every chunk sees the same value, and
 * it is wiped by a full reload — which is precisely the lifetime wanted here.
 */
const FLAG = "__rdbUnlocked" as const;

type UnlockWindow = Window & { [FLAG]?: boolean };

export function isUnlocked(): boolean {
  // Server render: always locked, so the gate's check runs on the client.
  if (typeof window === "undefined") return false;
  return (window as UnlockWindow)[FLAG] === true;
}

export function markUnlocked(): void {
  if (typeof window === "undefined") return;
  (window as UnlockWindow)[FLAG] = true;
}

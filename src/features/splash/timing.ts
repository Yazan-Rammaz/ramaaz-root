/**
 * Splash timings, shared so the entry redirect can wait for the bar rather
 * than guessing.
 *
 * `/` resolves where to send the user in a few hundred milliseconds, far
 * sooner than the bar finishes. Navigating the moment it knows would cut the
 * splash off mid-fill, so <EntryRedirect> holds until FILL_MS has elapsed
 * since the document loaded and only then moves on.
 */
export const SPLASH_FILL_MS = 4500; // bar fill + how long the splash stays up
export const SPLASH_SLIDE_MS = 450; // iOS slide-out once the bar completes

/**
 * Whether a splash is on screen right now.
 *
 * <EntryRedirect> must only wait when there is something to wait FOR. The
 * splash is skipped on any load this tab has already seen — a hard redirect
 * back to "/" after signing out, for instance — and without this the entry
 * would sit on a blank screen for the full 4.5s with no splash covering it.
 */
const PLAYING = "__rootSplashPlaying" as const;

/**
 * When the splash will actually be gone — `performance.now()` scale.
 *
 * ⚠️ THE DEADLINE CANNOT BE DERIVED FROM THE CONSTANTS, and assuming it could
 * is a bug that only shows up on slow devices. The splash's timers start when
 * `SplashGate`'s effect runs, which is after hydration — not at navigation.
 * `waitForSplash` computed `FILL + SLIDE - performance.now()`, i.e. it assumed
 * the splash began at time zero, so it under-waited by however long hydration
 * took: nothing on a desktop, well over a second on a phone. Callers were
 * released while the splash was still on screen, which is the exact thing they
 * called it to avoid.
 *
 * Recorded at the moment the splash starts, so the wait is right however long
 * the page took to come up.
 */
const ENDS_AT = "__rootSplashEndsAt" as const;

type SplashWindow = Window & { [PLAYING]?: boolean; [ENDS_AT]?: number };

export function setSplashPlaying(value: boolean): void {
  if (typeof window === "undefined") return;
  const win = window as SplashWindow;
  win[PLAYING] = value;
  // Stamped here rather than by the caller: this is called exactly when the
  // splash appears and when it is gone, so it is the one place that knows.
  win[ENDS_AT] = value
    ? performance.now() + SPLASH_FILL_MS + SPLASH_SLIDE_MS
    : undefined;
}

export function isSplashPlaying(): boolean {
  if (typeof window === "undefined") return false;
  return (window as SplashWindow)[PLAYING] === true;
}

/** Milliseconds until the splash is off screen; 0 when none is playing. */
function splashRemaining(): number {
  if (typeof window === "undefined") return 0;
  const endsAt = (window as SplashWindow)[ENDS_AT];
  if (typeof endsAt !== "number") return 0;
  return Math.max(0, endsAt - performance.now());
}

/**
 * Resolves once the splash is off the screen — immediately when none is
 * playing.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The splash is a `fixed` overlay and nothing more: the page beneath it mounts,
 * runs its effects and does its work the whole time it is up. That is right for
 * almost everything — the point of a splash is to cover work — and wrong for
 * anything the user is supposed to be LOOKING at when it happens.
 *
 * The camera is the case. Landing on the face check with a full document load
 * put the browser's permission prompt on screen over the splash, before the
 * person had seen the page that was asking, and opened a billed AWS Face
 * Liveness session behind a cover they were still watching. A permission
 * request with no visible context is one people refuse.
 *
 * ── Why two frames before reading the flag ──────────────────────────────────
 * ⚠️ `isSplashPlaying()` IS NOT TRUE YET when a caller's effect first runs, and
 * reading it directly is the bug this helper exists to hide.
 *
 * `SplashGate` lives in the layout, so it is a PARENT of everything that would
 * call this — and effects run child-first, so the caller's effect runs before
 * the gate's. The gate then defers its own decision by one `requestAnimationFrame`
 * (it needs `sessionStorage` and Navigation Timing, neither of which exists
 * during render). So the flag is claimed two steps after a caller could first
 * ask for it, and a caller that asks early is told "no splash" while one is
 * about to appear.
 *
 * One frame is not enough either: a callback registered from the caller's
 * effect fires BEFORE the gate's, in the same frame, because it was registered
 * first. The second frame is the one that lands after the gate has decided.
 *
 * `EntryRedirect` sidesteps all of this by reading the flag after an `await`
 * that happens to be long enough. That works and is fragile; this is the
 * explicit version.
 *
 * ── Where the deadline comes from ───────────────────────────────────────────
 * The stamp `setSplashPlaying` records when the splash STARTS — see ENDS_AT.
 * ⚠️ It is not `FILL + SLIDE - performance.now()`. That was the original, and
 * it silently under-waited by however long hydration took, because it assumed
 * the splash had begun at navigation. On a phone that is well over a second,
 * and the caller was let go with the splash still covering the screen.
 */
export async function waitForSplash(): Promise<void> {
  if (typeof window === "undefined") return;

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  if (!isSplashPlaying()) return;

  const remaining = splashRemaining();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

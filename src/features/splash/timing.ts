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

type SplashWindow = Window & { [PLAYING]?: boolean };

export function setSplashPlaying(value: boolean): void {
  if (typeof window === "undefined") return;
  (window as SplashWindow)[PLAYING] = value;
}

export function isSplashPlaying(): boolean {
  if (typeof window === "undefined") return false;
  return (window as SplashWindow)[PLAYING] === true;
}

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

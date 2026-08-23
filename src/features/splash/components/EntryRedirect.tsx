"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { resolveEntry } from "../actions";
import { SPLASH_FILL_MS, isSplashPlaying } from "../timing";

/**
 * The "/" entry has no content of its own — it decides where to send the user.
 * Runs the auth check (server action) and replaces the URL with wherever they
 * belong: /login when signed out, otherwise the dashboard, which opens behind
 * the passcode gate.
 *
 * It waits for the splash's progress bar to finish before navigating. The auth
 * check resolves in a few hundred milliseconds, so without the wait the splash
 * would be cut off part-filled.
 *
 * The delay is measured from `performance.now()` — time since the document
 * loaded — rather than from mount, so it absorbs however long the check took,
 * and collapses to zero when "/" is reached later by client-side navigation,
 * where no splash is playing.
 */
export function EntryRedirect() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    void (async () => {
      let target = "/login";
      try {
        target = await resolveEntry();
      } catch {
        // Backend unreachable — sign-in is the safe destination.
      }
      if (!active) return;

      // Checked AFTER the await: effects run child-first, so the splash in the
      // layout has claimed the flag by now. Skipped loads must not sit blank.
      const remaining = isSplashPlaying()
        ? Math.max(0, SPLASH_FILL_MS - performance.now())
        : 0;
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      if (active) router.replace(target);
    })();

    return () => {
      active = false;
    };
  }, [router]);

  return null;
}

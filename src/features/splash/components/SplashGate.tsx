"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import {
    SPLASH_FILL_MS as FILL_MS,
    SPLASH_SLIDE_MS as SLIDE_MS,
    setSplashPlaying,
} from "../timing";

/**
 * Splash overlay. Server-rendered (visible on first paint) on EVERY full
 * document load — opening the site, refreshing any page — then slides away
 * (iOS push, left→right) to reveal the page beneath.
 *
 * Purely visual cover; routing is handled by the routes themselves.
 */

/**
 * Should the splash play right now?
 *
 * The rule is: FIRST OPEN in this tab, or a browser RELOAD. Nothing else —
 * not a client-side navigation, not the passcode lock, and not the full page
 * loads that Server-Action redirects turn out to trigger.
 *
 * Two signals are needed because neither alone is enough:
 *
 *   - `sessionStorage` marks that this tab has already seen it. It survives
 *     page loads, so a redirect mid-flow no longer replays the animation. A
 *     window flag could not do this: a full load wipes it, which is precisely
 *     the case being suppressed.
 *   - Navigation Timing says HOW the document was entered. A reload must play
 *     again even though the tab has seen it, so `reload` overrides the marker.
 *
 * Closing the tab clears sessionStorage, so the next open counts as first.
 */
const SEEN_KEY = "root_splash_seen";

function shouldPlay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const [entry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    if (entry?.type === "reload") return true;
    return sessionStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    // Storage unavailable (private mode) — better to show it than to break.
    return true;
  }
}

function markSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* nothing to do */
  }
}

// iOS navigation easing (matches presets.ts `iosEase`).
const IOS_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

// XD px -> scaling rem (1 XD px = 0.0625rem).
const rem = (px: number) => `${px * 0.0625}rem`;

export function SplashGate() {
  const [filled, setFilled] = useState(false);
  // Starts "pending" — renders nothing — because the decision depends on
  // sessionStorage and Navigation Timing, neither of which exists on the
  // server. Deciding here rather than in the initial state keeps server and
  // client markup identical, so there is no hydration mismatch; the cost is
  // that the splash appears one frame after mount instead of in the SSR HTML.
  const [phase, setPhase] = useState<"pending" | "show" | "hide" | "gone">(
    "pending",
  );

  useEffect(() => {
    let fillRaf = 0;
    let toHide: ReturnType<typeof setTimeout>;
    let toGone: ReturnType<typeof setTimeout>;

    // The whole decision runs inside a frame callback rather than the effect
    // body: setting state synchronously there triggers a cascading render (and
    // the project's react-hooks rules reject it). A frame's delay is invisible.
    const decideRaf = requestAnimationFrame(() => {
      if (!shouldPlay()) {
        setSplashPlaying(false);
        setPhase("gone");
        return;
      }
      markSeen();
      setSplashPlaying(true);
      setPhase("show");

      // One more frame so the bar paints at 0% before transitioning to 100%.
      fillRaf = requestAnimationFrame(() => setFilled(true));
      // Bar completes -> slide out -> unmount.
      toHide = setTimeout(() => setPhase("hide"), FILL_MS);
      toGone = setTimeout(() => {
        setSplashPlaying(false);
        setPhase("gone");
      }, FILL_MS + SLIDE_MS);
    });

    return () => {
      cancelAnimationFrame(decideRaf);
      if (fillRaf) cancelAnimationFrame(fillRaf);
      clearTimeout(toHide);
      clearTimeout(toGone);
    };
  }, []);

  if (phase === "gone" || phase === "pending") return null;

  return (
    // Outer clips the slide so it can never create a scrollbar.
    <div
      aria-hidden={phase === "hide"}
      className={cn(
        "fixed inset-0 z-50 overflow-hidden",
        phase === "hide" && "pointer-events-none",
      )}
    >
      {/* Inner panel slides off to the right (reveal sweeps left -> right). */}
      <div
        className={cn(
          "bg-background absolute inset-0 grid place-items-center transition-transform",
          phase === "hide" && "translate-x-full",
        )}
        style={{ transitionDuration: `${SLIDE_MS}ms`, transitionTimingFunction: IOS_EASE }}
      >
        {/* Brand mark — vertically centered. rdb glyph + "Ramaaz Digital
            Banking" subtitle both live inside rdb.svg. */}
        <div className="relative flex flex-col items-center">
          <Icon
            name="auth/rdb"
            width={144.21}
            height={104.22}
            alt="Ramaaz Digital Banking"
          />

          {/* Loader group sits 138 XD px below the brand mark, centered. */}
          <div
            className="absolute top-full left-1/2 flex -translate-x-1/2 flex-col items-center"
            style={{ marginTop: rem(138) }}
          >
            {/* Track 220 x 8 with a true 0.5px outline (#707070); blue fill
                (#3066CC) animates 0 -> 100%. Inner clip layer rounds the fill. */}
            <div
              className="hairline relative h-8 w-220 rad-4"
              style={
                {
                  "--hairline-radius": rem(4),
                  "--hairline-color": "#707070",
                } as React.CSSProperties
              }
              role="progressbar"
              aria-label="Loading"
            >
              <div className="absolute inset-0 overflow-hidden rad-4">
                <div
                  className="bg-primary absolute inset-y-0 start-0 transition-[width] ease-in-out"
                  style={{
                    width: filled ? "100%" : "0%",
                    transitionDuration: `${FILL_MS}ms`,
                  }}
                />
              </div>
            </div>

            {/* Fixed English brand label (not localized, static). */}
            <span
              className="fz-14 text-black font-normal"
              style={{ marginTop: rem(12), lineHeight: rem(20) }}
            >
              Ramaaz Root
            </span>
          </div>
        </div>

        {/* Powered-by mark — bottom corner, 30 XD px inset (mirrors in RTL). */}
        <Icon
          name="auth/rdb_powered_by"
          width={102.25}
          height={86.56}
          className="absolute bottom-30 start-30"
        />
      </div>
    </div>
  );
}

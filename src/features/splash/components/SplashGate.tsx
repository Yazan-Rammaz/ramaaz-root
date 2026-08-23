"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { SPLASH_FILL_MS as FILL_MS, SPLASH_SLIDE_MS as SLIDE_MS } from "../timing";

/**
 * Splash overlay. Server-rendered (visible on first paint) on EVERY full
 * document load — opening the site, refreshing any page — then slides away
 * (iOS push, left→right) to reveal the page beneath.
 *
 * Purely visual cover; routing is handled by the routes themselves.
 */

/**
 * Has the splash already played in THIS document?
 *
 * It lives in the root layout so a refresh of any page shows it. But the root
 * layout also REMOUNTS whenever the router cache is invalidated — which every
 * Server Action that writes a cookie does, and the login flow writes one at
 * each step. Without this guard it replayed its 4.5s animation after every
 * step, which looked exactly like the page reloading.
 *
 * `window` separates the two cases precisely: it survives remounts inside a
 * document and is wiped by a real page load, which is the moment the splash
 * SHOULD play. sessionStorage would be wrong — it outlives a refresh and would
 * suppress the splash when it ought to run.
 */
const PLAYED = "__rdbSplashPlayed" as const;

type SplashWindow = Window & { [PLAYED]?: boolean };

function hasPlayed(): boolean {
  if (typeof window === "undefined") return false;
  return (window as SplashWindow)[PLAYED] === true;
}

function markPlayed(): void {
  if (typeof window === "undefined") return;
  (window as SplashWindow)[PLAYED] = true;
}

// iOS navigation easing (matches presets.ts `iosEase`).
const IOS_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

// XD px -> scaling rem (1 XD px = 0.0625rem).
const rem = (px: number) => `${px * 0.0625}rem`;

export function SplashGate() {
  const [filled, setFilled] = useState(false);
  // A remount inside the same document resolves straight to "gone". On a real
  // page load the flag is unset, so server and client both start at "show" and
  // hydration agrees.
  const [phase, setPhase] = useState<"show" | "hide" | "gone">(() =>
    hasPlayed() ? "gone" : "show",
  );

  useEffect(() => {
    if (phase === "gone") return;
    // Claimed on mount, not when the animation ends: an invalidation part-way
    // through would otherwise remount and restart it.
    markPlayed();

    // Start the bar fill after first paint so the transition runs.
    const raf = requestAnimationFrame(() => setFilled(true));
    // Bar completes -> slide out -> unmount.
    const toHide = setTimeout(() => setPhase("hide"), FILL_MS);
    const toGone = setTimeout(() => setPhase("gone"), FILL_MS + SLIDE_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(toHide);
      clearTimeout(toGone);
    };
  }, []);

  if (phase === "gone") return null;

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

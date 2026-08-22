"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";

/**
 * Splash overlay for the "/" entry hop. Server-rendered (visible on first
 * paint), then slides away (iOS push, left→right) to reveal the page beneath.
 *
 * Mounted by `app/page.tsx` ONLY — deliberately not the root layout. There it
 * remounted every time the router cache was invalidated (which every Server
 * Action writing a cookie does) and replayed the whole 4.5s animation, so each
 * step of the login flow looked like a page reload.
 *
 * Purely visual cover; routing is handled by the routes themselves.
 */
const FILL_MS = 4500; // bar fill + how long the splash stays up
const SLIDE_MS = 450; // iOS slide-out once the bar completes

// iOS navigation easing (matches presets.ts `iosEase`).
const IOS_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

// XD px -> scaling rem (1 XD px = 0.0625rem).
const rem = (px: number) => `${px * 0.0625}rem`;

export function SplashGate() {
  const [filled, setFilled] = useState(false);
  const [phase, setPhase] = useState<"show" | "hide" | "gone">("show");

  useEffect(() => {
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

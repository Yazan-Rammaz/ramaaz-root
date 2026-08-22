"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";

/**
 * Global splash overlay. Lives in the root layout, so it is server-rendered
 * (visible on first paint) on EVERY full document load — opening the site,
 * refreshing any page, or landing after logout — then slides away (iOS push,
 * left→right) to reveal the page underneath. It does NOT re-appear on
 * client-side navigation (the root layout persists).
 *
 * Purely visual cover; routing is handled by the routes themselves.
 */
const FILL_MS = 4500; // bar fill + how long the splash stays up
const SLIDE_MS = 450; // iOS slide-out once the bar completes

/**
 * Has the splash already played in THIS document?
 *
 * It must play once per real page load and never again — but this component
 * lives in the root layout, and the root layout REMOUNTS more often than you
 * would expect. Writing a cookie inside a Server Action invalidates the whole
 * router cache (the response carries `x-action-revalidated: 1`), so Next
 * refetches the tree from the root. Every action in the login flow writes a
 * cookie — the flow cookie, then the auth cookies — so the splash was
 * remounting and replaying its 4.5s animation after each one, which read as
 * the page reloading on every API call.
 *
 * The flag lives on `window`: one object per document, so it survives any
 * number of remounts, and a genuine page load starts fresh — exactly the
 * lifetime wanted. (sessionStorage would be wrong: it would outlive a refresh
 * and suppress the splash when it should play.)
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
  // Skip straight to "gone" if this document has already played the splash.
  // Safe during hydration: on a genuine page load the flag is unset, so server
  // and client both start at "show". A remount can only happen later, on the
  // client, where reading the flag is correct.
  const [phase, setPhase] = useState<"show" | "hide" | "gone">(() =>
    hasPlayed() ? "gone" : "show",
  );

  useEffect(() => {
    if (phase === "gone") return;
    // Claim the document immediately, not when the animation ends: an
    // invalidation part-way through would otherwise remount and restart it.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps } from "react";

/**
 * A `<Link>` that loads its whole page once someone shows they mean to go there
 * (2026-11-24): the pointer RESTING on it, keyboard focus resting on it, or a
 * finger touching it.
 *
 * Before that it is Next's default: only the page's skeleton (`loading.tsx`) is
 * fetched for every link on screen, so a tap shows it at once, on a phone too.
 *
 * ⚠️ Why "resting", and why one at a time. The first version loaded the page the
 * instant the pointer touched the link. Moving the mouse across the navbar then
 * loaded every section at once, and the project (RDB) answers its reads one
 * after another: they queued for up to 9 s, and the click that followed waited
 * behind them all — 11.6 s to open the head office (measured 2026-11-24). Now
 * the pointer has to stay REST_MS, and a page starts loading ahead only if no
 * other did in the last GAP_MS, so passing over the bar loads nothing extra and
 * a queue cannot build in front of a click. A touch is a tap: no wait.
 *
 * Nothing on the current page changes: the fetch runs in the background and is
 * only rendered on the click. A fetched page is kept 30 s (`staleTimes` in
 * next.config.ts); any save clears it, so it is never older than that.
 */
const REST_MS = 250;
const GAP_MS = 1500;
let lastAhead = 0;

export function IntentLink({ onMouseEnter, onMouseLeave, onFocus, onBlur, onTouchStart, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const go = () => {
    if (intent) return;
    const now = Date.now();
    if (now - lastAhead < GAP_MS) return;
    lastAhead = now;
    setIntent(true);
  };
  const rest = () => {
    if (intent || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      go();
    }, REST_MS);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <Link
      {...props}
      // Before intent: Next's own default (null), the skeleton only. After: the whole page.
      prefetch={intent ? true : null}
      onMouseEnter={(e) => {
        rest();
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        leave();
        onMouseLeave?.(e);
      }}
      onFocus={(e) => {
        rest();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        leave();
        onBlur?.(e);
      }}
      onTouchStart={(e) => {
        go();
        onTouchStart?.(e);
      }}
    />
  );
}

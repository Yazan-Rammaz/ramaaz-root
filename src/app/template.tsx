"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { iosEase } from "@/components/motion/presets";

/**
 * Re-mounts on every navigation (layout.tsx persists; template.tsx remounts),
 * so it drives the iOS-style page transition: each new page slides in from the
 * right with the iOS navigation easing. Reduced-motion users get no slide.
 * (The splash overlay hides the very first load's slide.)
 *
 * The element is the same for everybody — only the transition differs, and a
 * transition is never written into the HTML. Rendering a plain `<div>` for
 * reduced motion broke hydration: the server cannot know the setting, so it
 * rendered the sliding `motion.div` (with its `translateX(100%)` style) while
 * such a browser rendered a `<div>` without one.
 */
export default function Template({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      className="h-full"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      transition={reduce ? { duration: 0 } : iosEase}
    >
      {children}
    </motion.div>
  );
}

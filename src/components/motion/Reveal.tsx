"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  iosSpring,
  REVEAL_STAGGER_S,
  revealItem,
  revealX,
  revealY,
} from "./presets";
import { cn } from "@/lib/utils/cn";

/**
 * A group that unfolds when `show` turns true and folds away when it turns
 * false: the container grows along `axis`, and every `<RevealItem>` inside pops
 * in on a stagger (and out in reverse).
 *
 * - `x` unfolds from the inline START edge, so it mirrors itself in RTL.
 * - `y` unfolds top → bottom.
 *
 * Only the cross-axis is left visible (`overflow-x-clip` for `x`), so anything
 * hanging off an item the other way — the navbar's selected tab — still shows.
 *
 * `initial={false}`: a group that is already shown on page load is simply
 * there. The animation is for the moment it CHANGES, not for every reload.
 * Spacing between the group and its neighbour belongs INSIDE `className`
 * (`ps-8`, `pt-16`), so it collapses with the group instead of leaving a gap.
 */
export function Reveal({
  show,
  axis,
  className,
  children,
}: {
  show: boolean;
  axis: "x" | "y";
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          variants={axis === "x" ? revealX : revealY}
          initial="hidden"
          animate="shown"
          exit="hidden"
          transition={
            reduce
              ? { duration: 0 }
              : { ...iosSpring, staggerChildren: REVEAL_STAGGER_S }
          }
          className={cn(
            "flex shrink-0",
            axis === "x" ? "overflow-x-clip" : "flex-col overflow-y-clip",
            className,
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** One item in a `<Reveal>` — inherits the group's state, pops in on its turn. */
export function RevealItem({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      variants={revealItem}
      transition={reduce ? { duration: 0 } : iosSpring}
      className="shrink-0"
    >
      {children}
    </motion.div>
  );
}

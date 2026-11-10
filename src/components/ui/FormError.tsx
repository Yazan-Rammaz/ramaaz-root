"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { iosEase } from "@/components/motion/presets";
import { cn } from "@/lib/utils/cn";

/**
 * THE error line — the one way an action's error is shown in this app: plain
 * red text, centered, no box, no heading. Renders nothing without a message.
 *
 * - `hideAfterMs`: the line fades out on its own after that long. For errors
 *   that are a passing notice (a rate limit, a dropped request), not for one
 *   the person has to act on — that stays until they do.
 * - `attempt`: pass something that changes per try (the action state object
 *   works) when the SAME message can come back twice in a row — it restarts
 *   the line (and its timer) instead of leaving it hidden.
 *
 * Clearing on edit is the caller's job: pass no `message` once the input that
 * caused it changes.
 *
 * Per-field errors under an input are not this — they sit with their field.
 */
export function FormError({
  message,
  hideAfterMs,
  attempt,
  className,
}: {
  message?: string | null;
  hideAfterMs?: number;
  attempt?: unknown;
  className?: string;
}) {
  return (
    <AnimatePresence mode="wait">
      {message && (
        <Line
          key={`${message}|${keyOf(attempt)}`}
          message={message}
          hideAfterMs={hideAfterMs}
          className={className}
        />
      )}
    </AnimatePresence>
  );
}

/** One showing of one message — remounted per message/attempt, so its timer starts fresh. */
function Line({
  message,
  hideAfterMs,
  className,
}: {
  message: string;
  hideAfterMs?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (hideAfterMs == null) return;
    const timer = window.setTimeout(() => setVisible(false), hideAfterMs);
    return () => window.clearTimeout(timer);
  }, [hideAfterMs]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.p
          role="alert"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0 } : iosEase}
          className={cn("fz-12 text-center leading-normal text-red-500", className)}
        >
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/** A stable key for any value: objects get an id of their own, the first time they're seen. */
const ids = new WeakMap<object, number>();
let next = 0;
function keyOf(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (!ids.has(value)) ids.set(value, ++next);
    return `o${ids.get(value)}`;
  }
  return String(value ?? "");
}

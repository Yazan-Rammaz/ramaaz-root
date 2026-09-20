'use client';

import { motion } from 'motion/react';

/**
 * The step progress bar, drawn from `/assets/icons/verification/face-bar.svg`.
 *
 * Lived in `screens/AwsFaceLiveness.tsx` until that screen was deleted (it ran a
 * second, MediaPipe-based liveness engine that nothing navigated to). It is
 * kept because `IDCaptureScreen` draws four of them — one per document side,
 * plus the passport case — and a progress bar was never part of that screen's
 * job in the first place.
 */

/**
 * What the fill is saying.
 *
 * `idle` — nothing yet · `aligned` — close, not committed · `locked` — accepted
 * · `red` — rejected. The colours are the same four this flow uses everywhere.
 */
export type Tone = 'idle' | 'aligned' | 'locked' | 'red';

export function FaceProgressBar({ pct, tone }: { pct: number; tone: Tone }) {
    const fillColor =
        tone === 'red'
            ? '#EF4444'
            : tone === 'locked'
              ? '#22C55E'
              : tone === 'aligned'
                ? '#F59E0B'
                : '#388CFF';
    return (
        <svg
            width="100%"
            height="5"
            viewBox="0 0 330 5"
            preserveAspectRatio="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            {/* Track — same stroke style as face-bar.svg */}
            <rect
                x="0.25"
                y="0.25"
                width="329.5"
                height="4.5"
                rx="2.25"
                fill="none"
                stroke="#707070"
                strokeWidth="0.5"
            />
            {/* Animated fill */}
            <motion.rect
                x="0"
                y="0"
                height="5"
                rx="2.5"
                fill={fillColor}
                animate={{ width: 330 * Math.max(0, Math.min(1, pct / 100)) }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
            />
        </svg>
    );
}

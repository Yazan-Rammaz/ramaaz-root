'use client';

import type React from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * The four corner brackets from the XD face frames — 18 x 18, 6 thick, with an
 * 8 radius on the elbow.
 *
 * Extracted so the single-frame capture and the AWS liveness check draw the
 * same marks rather than two that drift apart. Both are "put your face here",
 * and a user walking the flow should not be able to tell that one frame is our
 * camera and the other is Amazon's.
 *
 * ── The radius is an inline logical property ────────────────────────────────
 * There is no utility for it. This project's radius utility is `rad-*`, which
 * sets all four corners, and Tailwind's per-corner logical classes
 * (`rounded-ss-*` and friends) do not read the XD spacing scale. Setting ONE
 * corner is the point: it is the elbow where the two borders meet, and rounding
 * the other three tapers the open ends of each arm to a point.
 *
 * Logical (`start-start` rather than `top-left`) so it mirrors in RTL on its
 * own, following the `start-0` / `end-0` placement — AGENTS.md §9.
 */

/**
 * Radius on the elbow, in XD pixels.
 *
 * With 6-wide arms this leaves an inner radius of 2, which is what keeps the
 * bend reading as a bend rather than a mitre. Raising it past the arm width
 * would round the inside faster than the outside and the corner starts to look
 * like a comma.
 */
const BRACKET_RADIUS = 8;

/** XD px -> scaling rem. */
const rem = (px: number) => `${px * 0.0625}rem`;

const CORNERS = [
    ['top-0 start-0', 'border-t-6 border-s-6', 'borderStartStartRadius'],
    ['top-0 end-0', 'border-t-6 border-e-6', 'borderStartEndRadius'],
    ['bottom-0 start-0', 'border-b-6 border-s-6', 'borderEndStartRadius'],
    ['bottom-0 end-0', 'border-b-6 border-e-6', 'borderEndEndRadius'],
] as const;

export function CornerBrackets({
    color,
    inset,
    opacity = 1,
    className,
}: {
    color: string;
    /** Distance from the frame's edge, in XD pixels. */
    inset: number;
    opacity?: number;
    className?: string;
}) {
    return (
        <>
            {CORNERS.map(([pos, edges, corner]) => (
                <span
                    key={pos}
                    aria-hidden
                    className={cn(
                        'pointer-events-none absolute h-18 w-18 transition-all duration-500 ease-out motion-reduce:transition-none',
                        pos,
                        edges,
                        className,
                    )}
                    style={
                        {
                            borderColor: color,
                            [corner]: rem(BRACKET_RADIUS),
                            margin: rem(inset),
                            opacity,
                        } as React.CSSProperties
                    }
                />
            ))}
        </>
    );
}

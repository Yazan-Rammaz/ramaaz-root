'use client';

import { Icon } from '@/components/ui/Icon';

/**
 * The AI mark, alive — one big star and two small ones, each moving on its own.
 *
 * ── Why three icons and not one ─────────────────────────────────────────────
 * `regions/ai-star` is a single glyph holding all three stars, and a glyph is
 * one shape: masked into an element it can be scaled, rotated and recoloured,
 * but its parts cannot move relative to each other. Animating them separately
 * means they have to BE separate.
 *
 * So the source was split into three files, each keeping the ORIGINAL viewBox
 * and holding one path. Stacked at the same size they land exactly where the
 * combined glyph drew them, with no positioning arithmetic to get wrong and
 * nothing to re-derive if the artwork is ever redrawn.
 *
 * ── The motion, and why it is deliberately not one animation ────────────────
 * Three durations that share no common factor — 2.3s, 3.1s, 4.7s. The pattern
 * they make together therefore never repeats within any wait this is shown
 * for, which is the whole point: three things drifting is alive, three things
 * pulsing in step is a loading spinner.
 *
 * The two small stars run in OPPOSITE phase, so one is rising as the other
 * falls. The big one only shifts a little side to side — it is the anchor, and
 * a mark whose largest element wanders reads as broken rather than animated.
 *
 * ⚠️ `regions/ai-star` (the combined glyph) is still used elsewhere and must
 * stay. These three are additions, not replacements.
 */
export function AiSparkle({
    width = 78,
    height = 90,
}: {
    width?: number;
    height?: number;
}) {
    return (
        /*
         * The box the three stack in. Sized once here; every child is
         * `absolute inset-0` at the same dimensions, which is what keeps them
         * registered with one another.
         */
        <span
            aria-hidden
            className="verdict-spark relative inline-block"
            style={{
                width: `${width * 0.0625}rem`,
                height: `${height * 0.0625}rem`,
            }}
        >
            <span className="verdict-spark-big absolute inset-0">
                <Icon name="regions/ai-star-big" width={width} height={height} mask alt="" />
            </span>
            <span className="verdict-spark-top absolute inset-0">
                <Icon name="regions/ai-star-top" width={width} height={height} mask alt="" />
            </span>
            <span className="verdict-spark-bottom absolute inset-0">
                <Icon name="regions/ai-star-bottom" width={width} height={height} mask alt="" />
            </span>
        </span>
    );
}

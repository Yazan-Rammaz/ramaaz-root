'use client';

import { Icon } from '@/components/ui/Icon';

/**
 * Twenty of the AI mark's stars, scattered over a frame and twinkling in waves.
 *
 * What it is FOR: the comparison screen waits on a server with nothing to
 * report, and the picture it waits over is the proposition itself — a face and
 * a document being held against each other. The single centred mark belongs to
 * the checking state, where the photograph is not the point; here it would sit
 * on the very face it is talking about. So the same idea is spread across the
 * frame: the model is going over the whole photograph, and these are where it
 * is looking.
 *
 * The motion, the colour and the gleam are all `.spark-field-star` in
 * globals.css, and the gleam is literally the mark's own `verdict-gleam` — so
 * the brilliance here cannot drift from the brilliance there.
 *
 * ── The schedule, which is the whole design ─────────────────────────────────
 * Twenty stars in three groups (7, 7, 6) that take a 4.8s cycle in turn, each
 * star alight for 36.5% of it and each starting 100ms after the one before it
 * in its group. Those three numbers were solved together, not chosen: they hold
 * the field at five to seven lit at every instant, six or seven most of the
 * time. The keyframe comment in globals.css carries the arithmetic and what
 * breaks on either side of it.
 *
 * ⚠️ THE 100ms STAGGER IS WHY THE SCREEN NEVER OPENS ON TWO STARS TOGETHER.
 * A group whose members share a delay flicks seven stars on at once, which
 * reads as a light switch rather than a field coming alive — and the first
 * cycle is the one everybody sees. Staggered, the first star arrives alone, the
 * second 140ms later, and the field is full by 0.8s.
 *
 * ⚠️ NO RANDOMNESS. Every number below is a literal or derived from the index.
 * `Math.random()` here would differ between the server render and the client's
 * and throw a hydration mismatch — and worse, it would make a look that cannot
 * be reviewed, since nobody would be seeing the same field twice.
 */

/**
 * The cycle every star shares. How much of it a star is lit for lives in
 * `spark-field-lit` (globals.css) — see the schedule note above.
 */
const LIT_CYCLE = 4.8;

/**
 * Where each group's slot starts: the cycle in three, evenly.
 *
 * ⚠️ These must stay in step with `spark-field-lit`'s 36.5%. The groups start
 * 1.6s apart and each star is lit 1.75s, and that 0.15s of overlap is what
 * hands the field from one group to the next rather than dropping it. Move
 * either number without the other and the count falls out of five-to-seven.
 */
const GROUP_OFFSET = [0, 1.6, 3.2];

/**
 * The field.
 *
 * `x`/`y` are percentages of the frame and land on the STAR, not on its box —
 * `.spark-field-star` pulls the box back by the star's own offset within it.
 * `size` is the box in XD px; the star inside it draws at roughly a third of
 * that, so 28–38 here is a 10–14px star.
 *
 * ⚠️ These were 20–30 and too small to read. A star that size over a sharp
 * photograph is a speck — present in the DOM, and not something anybody
 * registers as a star. Half the legibility problem was scale and the other half
 * was contrast (see `.spark-field-star`'s colour and shadows); both had to
 * move, and neither alone was enough.
 *
 * `group` is the slot it takes. Members of one group are kept apart on screen:
 * a group is what lights together, and seven stars lighting in one corner is a
 * flash rather than a field.
 *
 * ⚠️ The bottom fifth is deliberately empty. The ID card crossfades in at the
 * foot of this frame (`bottom-9`, 224 × 126) and paints over these, so stars
 * placed there would simply vanish for half of every comparison cycle.
 */
const STARS: { x: number; y: number; size: number; group: 0 | 1 | 2 }[] = [
    // Group 0 — the first to light. The opening pair is deliberately far
    // apart, so the first two arrivals read as a field rather than a cluster.
    { x: 10, y: 12, size: 36, group: 0 },
    { x: 62, y: 8, size: 30, group: 0 },
    { x: 86, y: 30, size: 38, group: 0 },
    { x: 24, y: 41, size: 30, group: 0 },
    { x: 70, y: 52, size: 36, group: 0 },
    { x: 40, y: 22, size: 28, group: 0 },
    { x: 8, y: 62, size: 34, group: 0 },

    // Group 1
    { x: 30, y: 6, size: 34, group: 1 },
    { x: 80, y: 14, size: 28, group: 1 },
    { x: 6, y: 34, size: 38, group: 1 },
    { x: 54, y: 36, size: 30, group: 1 },
    { x: 92, y: 48, size: 34, group: 1 },
    { x: 34, y: 58, size: 36, group: 1 },
    { x: 60, y: 66, size: 28, group: 1 },

    // Group 2
    { x: 46, y: 14, size: 38, group: 2 },
    { x: 18, y: 26, size: 28, group: 2 },
    { x: 94, y: 8, size: 34, group: 2 },
    { x: 14, y: 50, size: 36, group: 2 },
    { x: 76, y: 38, size: 30, group: 2 },
    { x: 48, y: 62, size: 34, group: 2 },
];

/**
 * Turn and gleam clocks, handed out by index.
 *
 * Neither list's length shares a factor with the other or with the number of
 * stars, so a star's rotation and its gleam are on unrelated clocks and stay
 * that way — the property the mark's own three stars have, which is what makes
 * a group of them read as alive rather than as one animation playing many
 * times.
 */
const TURN = [2.3, 3.1, 4.7, 2.9, 3.7];
const GLEAM = [3.3, 4.1, 5.9, 4.7];

/**
 * The glyph's own aspect, and it is load-bearing.
 *
 * ⚠️ `<Icon mask>` paints the file as a `mask-size: contain` background, so a
 * box of the wrong shape letterboxes the artwork INSIDE itself and centres it —
 * which silently moves the star away from the 82.3% / 15.8% the CSS anchors and
 * rotates on. A square box would inset it by 6.65% a side and every star in the
 * field would sit a little right of where the table says, turning about a point
 * beside itself.
 *
 * Giving the box the viewBox's own ratio makes `contain` an exact fit, so the
 * percentages mean what they say. `AiSparkle` holds the same ratio (78 x 90)
 * for the same reason.
 */
const STAR_RATIO = 22.533 / 26;

export function SparkField() {
    return (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            {STARS.map((star, i) => {
                // Position within its own group — what staggers the arrivals.
                const inGroup = STARS.slice(0, i).filter((s) => s.group === star.group).length;
                const turn = TURN[i % TURN.length];
                const gleam = GLEAM[i % GLEAM.length];

                return (
                    <span
                        key={i}
                        className="spark-field-star"
                        style={
                            {
                                left: `${star.x}%`,
                                top: `${star.y}%`,
                                width: `${star.size * STAR_RATIO * 0.0625}rem`,
                                height: `${star.size * 0.0625}rem`,
                                '--lit-dur': `${LIT_CYCLE}s`,
                                '--lit-delay': `${GROUP_OFFSET[star.group] + inGroup * 0.1}s`,
                                '--turn-dur': `${turn}s`,
                                /*
                                 * Negative, so every star is already somewhere
                                 * different in its revolution on the first
                                 * frame rather than drifting apart over the
                                 * first few seconds — which is most of the time
                                 * anybody actually watches this. The multiplier
                                 * shares no factor with the durations above, so
                                 * the phases do not fall into a pattern.
                                 */
                                '--turn-delay': `${(-(i * 0.37)).toFixed(2)}s`,
                                '--gleam-dur': `${gleam}s`,
                                '--gleam-delay': `${(-(i * 0.53)).toFixed(2)}s`,
                            } as React.CSSProperties
                        }
                    >
                        {/* Always `ai-star-top`, never the other two: each file
                            keeps the combined mark's viewBox with its own star
                            in a different corner, and the CSS anchors on ONE of
                            those offsets. Mixing files would scatter the field
                            off its own coordinates. */}
                        <Icon
                            name="regions/ai-star-top"
                            width={star.size * STAR_RATIO}
                            height={star.size}
                            mask
                            alt=""
                        />
                    </span>
                );
            })}
        </span>
    );
}

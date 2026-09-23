'use client';

import { Icon } from '@/components/ui/Icon';
import { AiSparkle } from '@/features/kyc/components/AiSparkle';

/**
 * What sits on the glass — the mark, its light, and the frame's edge.
 *
 * Four states, one shape of presentation:
 *
 *   preparing the Face ID glyph in white, with rings leaving it. The camera is
 *             being opened and nothing has been asked of anyone yet.
 *   checking  the AI mark, breathing over a soft glow. Nothing has been
 *             decided, so nothing is coloured.
 *   passed    the Face ID glyph in green, with light travelling out of it to
 *             the corners. The phone-unlock gesture, deliberately: it is the
 *             one animation everybody already reads as "you are in".
 *   failed    the same glyph and the same light in red.
 *
 * ── Why `preparing` uses the verdict's glyph and not the AI star ────────────
 * Because it is about the CAMERA. The star means a model is working on your
 * photograph, and at that point nothing has been photographed — using it there
 * would make waiting for a lens look like processing. The Face ID glyph says
 * "the camera is coming", which is the one useful thing to know while a
 * permission prompt is up.
 *
 * ── Why the two verdicts share everything but a colour ──────────────────────
 * A pass and a refusal are the same EVENT — a decision arriving — and dressing
 * them differently would say the refusal is a different kind of thing, which it
 * is not. The colour carries it, and the colour is the only difference. That
 * also means there is one animation to tune rather than two that drift apart.
 *
 * ── Why it is its own component ─────────────────────────────────────────────
 * The sign-in and `/design/liveness-lab` both draw it, and a tuning bench that
 * renders its own copy of what it is tuning is worse than no bench: `GlassLab`
 * (since removed) did exactly that and was a step behind by its second change.
 * Anything that shows this state renders THIS.
 */

export type MarkPhase = 'preparing' | 'checking' | 'passed' | 'failed';

const PASS = '#34C759';
const FAIL = '#FF3B30';

export function VerdictMark({
    phase,
    rings = true,
}: {
    phase: MarkPhase;
    /**
     * Whether the standby rings pulse outward from the mark.
     *
     * ⚠️ OFF once the camera is live. The rings mean "waiting for something",
     * which is true of a camera that has not opened and false the moment it
     * has — at that point the person is not waiting, they are being asked to
     * position themselves, and two circles flashing outward over their own
     * face is motion competing with the task instead of describing it.
     *
     * The mark itself stays: it is still the thing telling them how to stand,
     * by growing as they come closer.
     */
    rings?: boolean;
}) {
    const color = phase === 'passed' ? PASS : phase === 'failed' ? FAIL : null;

    return (
        <>
            {/* The light out of the mark, to the edges and the corners.
                Scaled well past the frame on purpose — a radial gradient that
                stops at the frame's width never reaches its corners, and the
                corners are where the eye checks whether something completed. */}
            {color && (
                <span
                    aria-hidden
                    className="verdict-unlock pointer-events-none absolute inset-0"
                    style={{ '--verdict-color': color } as React.CSSProperties}
                />
            )}

            {/* The mark itself. */}
            <span
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
                <span className="relative flex items-center justify-center">
                    {phase === 'preparing' ? (
                        <>
                            {/* Two rings, half a cycle apart, so one is always
                                on its way out — a single ring leaves a dead
                                beat between repeats that reads as a stutter.
                                Only while the camera is still coming; see
                                `rings`. */}
                            {rings && (
                                <>
                                    <span className="verdict-ping absolute h-150 w-150" />
                                    <span className="verdict-ping verdict-ping--late absolute h-150 w-150" />
                                </>
                            )}
                            <span className="verdict-standby relative">
                                <Icon name="kyc/face_detect" size={72} mask alt="" />
                            </span>
                        </>
                    ) : phase === 'checking' ? (
                        <>
                            <span className="verdict-breathe absolute h-260 w-260 rounded-full" />
                            <span className="relative">
                                <AiSparkle />
                            </span>
                        </>
                    ) : (
                        <span
                            className="verdict-faceid relative"
                            style={{ '--verdict-color': color } as React.CSSProperties}
                        >
                            {/* `kyc/face_detect` is the bracket-cornered face —
                                the Face ID glyph. Masked, so it takes the
                                verdict colour from `currentColor` rather than
                                needing a second file per state. */}
                            <Icon name="kyc/face_detect" size={92} mask alt="" />
                        </span>
                    )}
                </span>
            </span>

            {/* The verdict, as the frame's own edge. Inset so it reads as a ring
                on the picture rather than a border added around it — the frame
                is `overflow: hidden`, so an outer ring would be clipped away. */}
            {color && (
                <span
                    aria-hidden
                    className="verdict-ring pointer-events-none absolute inset-0"
                    style={{ '--verdict-color': color } as React.CSSProperties}
                />
            )}
        </>
    );
}

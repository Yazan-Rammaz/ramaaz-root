'use client';

import { Icon } from '@/components/ui/Icon';
import { VERDICT_FAIL, VERDICT_PASS } from '@/features/kyc/components/VerdictMesh';

/**
 * The LIGHT on the glass — the wash, the frame's edge, and the fallback mark.
 *
 * ⚠️ THE MARK ITSELF IS THE MESH, and it is not drawn here. `VerdictMesh` puts
 * the wireframe on the face: blue-white while a model is looking at it, green
 * or red in one sweep when the answer lands. What is left in this file is
 * everything that belongs to the FRAME rather than to the face —
 *
 *   preparing the Face ID glyph in white, with rings leaving it. The camera is
 *             being opened, there is no face yet, and therefore no mesh: this
 *             is the one state whose mark is still a glyph.
 *   passed    light travelling out of the centre to the corners, and the
 *             frame's edge in green. The phone-unlock gesture, deliberately: it
 *             is the one animation everybody already reads as "you are in".
 *   failed    the same light and the same edge in red.
 *
 * — plus the Face ID glyph as a FALLBACK on a verdict, for the case where no
 * mesh could be built (see `glyph`).
 *
 * ⚠️ NOTHING IS DRAWN HERE WHILE CHECKING. The mesh is the checking animation
 * and the only one: the AI star that used to sit in the middle was removed on
 * request (2026-10-03), fallback included — with no mesh, `checking` is the
 * photograph under glass and nothing else.
 *
 * ── Why the colour travels through the states ───────────────────────────────
 * The mark used to be white while it thought and coloured only once it had
 * decided, which made the verdict look like a DIFFERENT animation arriving
 * rather than the same one resolving. Blue is the working colour — a model is
 * looking at your photograph — and the verdict is that same material turning
 * green or red. The mesh carries that; the palette the fallback glyphs use
 * (`--gem-*` in globals.css) says it the same way for the same reason.
 *
 * ── Why `preparing` uses the verdict's glyph and not the AI star ────────────
 * Because it is about the CAMERA. The star means a model is working on your
 * photograph, and at that point nothing has been photographed — using it there
 * would make waiting for a lens look like processing. The Face ID glyph says
 * "the camera is coming", which is the one useful thing to know while a
 * permission prompt is up.
 *
 * ── Why the two verdicts share everything but a colour ──────────────────────
 * (and why that is now literally true in the CSS: both derive their whole
 * palette from `--verdict-color` with `color-mix`, so there is one rule, not a
 * green one and a red one to keep in step.)
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

/*
 * The two verdict colours live with the mesh — it is the mark that wears them
 * now, and the light here only agrees with it. One definition, so the frame's
 * edge cannot be a different green from the face inside it.
 */
const PASS = VERDICT_PASS;
const FAIL = VERDICT_FAIL;

export function VerdictMark({
    phase,
    rings = true,
    glyph = true,
}: {
    phase: MarkPhase;
    /**
     * Whether to draw the centred GLYPH — the Face ID mark. Never drawn while
     * `checking`; see the note at the top.
     *
     * ⚠️ FALSE WHENEVER A MESH IS ON THE FACE, which is the normal case. The
     * wireframe IS the mark (see `VerdictMesh`); a star over the middle of it
     * would be a second thing saying the same sentence, on top of the face the
     * first one is describing.
     *
     * It stays true when the mesh could not be built — no still was grabbed,
     * the landmark model never downloaded, or there is no face to be found in
     * the frame. Those are ordinary, and the glyph is a complete mark on its
     * own; this is why it was not deleted. The light, the ring and the wash are
     * drawn either way, because they belong to the frame rather than to the
     * face.
     */
    glyph?: boolean;
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

            {/* The mark itself — unless the mesh is carrying it; see `glyph`. */}
            {glyph && (
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
                    ) : phase === 'checking' ? null : (
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
            )}

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

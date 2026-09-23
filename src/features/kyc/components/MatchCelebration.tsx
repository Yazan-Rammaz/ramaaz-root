'use client';

import { Icon } from '@/components/ui/Icon';

/**
 * The three seconds between "accepted" and the dashboard.
 *
 * ── Why a screen spends three seconds on nothing ────────────────────────────
 * Every other wait in this flow is filled with something a server is doing.
 * This one is not: by the time it runs, the document and the face have been
 * read, compared and signed for. Nothing is pending. The time is spent because
 * the end of an identity check is the one moment in it worth marking — a person
 * has just handed over their face and their papers, and cutting straight to a
 * dashboard reads as the screen having moved on before they did.
 *
 * ⚠️ IT IS SHOWN ONLY AFTER ACCEPTANCE, and that is not a detail of ordering.
 * A passing COMPARE is not a passing ENROLMENT — the comparison here runs at a
 * threshold of zero and the Worker applies the real one — so celebrating on the
 * comparison would announce a result that can still be refused. The caller
 * mounts this from the enrolment's own success path, after the Worker has
 * passed the document and signed for it. See FaceMatchScreen's `onAccepted`.
 *
 * The motion is `match-wash` and `match-burst` in globals.css, which carry the
 * reasoning for their own timing.
 */

/** Green. The same one the comparison frame turns on a pass. */
const PASS = '#34D317';

/**
 * Seven stars, and where they flash.
 *
 * ── Why seven, all at once ──────────────────────────────────────────────────
 * The star FIELD is a handover of five to seven at a time, staggered so no two
 * arrive together — it means "something is working through this". This is the
 * opposite event and has to look like it: every star at once, sudden, bigger
 * than it lands. One says continuing, the other says finished, and the only way
 * to keep them from reading as the same idea twice is to make the second one
 * abrupt where the first is gentle.
 *
 * ⚠️ NOT quite simultaneous. The delays span 90ms — far too short to read as a
 * sequence, long enough that the burst has a texture instead of being one flat
 * frame appearing. Seven stars on the exact same frame looks like a still image
 * being swapped in; 90ms of spread looks like something bursting.
 *
 * Positions are percentages of the frame and land on the STAR, not on its box
 * (see `.match-burst-star`).
 *
 * ── Scattered, and specifically NOT weighted to the top ─────────────────────
 * The first arrangement put three of the seven in the top fifth and read as a
 * banner across the head rather than as a burst: the eye finds a row instantly,
 * and a row is an arrangement, which is the one thing a burst must not look
 * like. These are spread over the whole frame — two high, three through the
 * middle band, two low — with no two sharing a row or a column, and the
 * spacings between them deliberately uneven. Regular spacing reads as a
 * pattern just as strongly as a row does.
 *
 * The dead centre stays empty. That is where the wash is brightest and where
 * the face is, so a star there is both invisible and on top of the thing the
 * screen is about.
 */
const BURST: { x: number; y: number; size: number; delay: number }[] = [
    { x: 22, y: 13, size: 46, delay: 0 },
    { x: 78, y: 21, size: 38, delay: 0.05 },
    { x: 7, y: 43, size: 40, delay: 0.02 },
    { x: 94, y: 57, size: 44, delay: 0.07 },
    { x: 37, y: 66, size: 34, delay: 0.09 },
    { x: 63, y: 86, size: 42, delay: 0.04 },
    { x: 16, y: 91, size: 36, delay: 0.08 },
];

/** The glyph's own aspect — see `SparkField`, same constant and same reason. */
const STAR_RATIO = 22.533 / 26;

export function MatchCelebration() {
    return (
        <span
            aria-hidden
            className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
            style={{ '--verdict-color': PASS } as React.CSSProperties}
        >
            {/* Green out of the centre, and its wake. Both overshoot the frame
                — a radial gradient that stops at the frame's width never
                reaches the corners, and the corners are where the eye checks
                whether something completed. */}
            <span className="match-wash absolute inset-0" />
            <span className="match-wash match-wash--wake absolute inset-0" />

            {BURST.map((star, i) => (
                <span
                    key={i}
                    className="match-burst-star"
                    style={
                        {
                            left: `${star.x}%`,
                            top: `${star.y}%`,
                            width: `${star.size * STAR_RATIO * 0.0625}rem`,
                            height: `${star.size * 0.0625}rem`,
                            '--burst-delay': `${star.delay}s`,
                        } as React.CSSProperties
                    }
                >
                    {/* `ai-star-top`, the same glyph the field uses — the
                        anchoring in CSS is measured against THIS file's star.
                        Bigger here: this is one event at full size, not twenty
                        small ones. */}
                    <Icon
                        name="regions/ai-star-top"
                        width={star.size * STAR_RATIO}
                        height={star.size}
                        mask
                        alt=""
                    />
                </span>
            ))}
        </span>
    );
}

'use client';

import { useEffect, useRef } from 'react';

import { CAPTURE_LIVE_MESH, MIRROR_CLASS } from '@/features/kyc/config/capture';
import type { StillMesh } from '@/features/kyc/hooks/useStillMesh';
import { coverCrop, withAlpha } from '@/features/kyc/services/faceMesh';

/**
 * The mark, for every state that has a face to put it on: THE WIREFRAME ITSELF.
 *
 * The same web the live camera wore, respun on the frozen frame — spinning out
 * from the middle of the face while the servers decide, then turning green or
 * red, in one sweep from the same centre, when they answer.
 *
 * ── What the waiting looks like, and why it is built the way it is ──────────
 * A WHITE web with sparkles on it, and the blue arrives with them: each sparkle
 * lights the run of lines it sits on, and they fade back to white as it goes. A
 * third of the sparkles have no star at all — they ARE the lines, a spoke and
 * the ring segments meeting it going blue and dimming again.
 *
 * ⚠️ The mesh is not blue. That was the first version — a blue-white wireframe
 * with blue glitter — and it read as a flat mask: nothing could be seen to
 * change, because everything was already the colour of the change. The blue has
 * to be an event on a white mesh, in step with the glitter, or it is just a
 * tint. See `BASE`, `SPARK` and `LINE_SHARE`.
 *
 * ── Why this replaced the AI star and the Face ID glyph ─────────────────────
 * Both were marks laid OVER the picture: a symbol in the middle of somebody's
 * face, saying "a model is working" and then "it agreed". The web says the same
 * two things about the same face without covering it, and it says them about
 * THIS face rather than in general — it is spun to the outline of the head the
 * check was actually run on.
 *
 * It also closes a seam. The wireframe was on the live camera a second earlier;
 * having it survive the shutter makes the wait and the verdict one continuous
 * screen instead of a camera screen followed by an icon screen.
 *
 * ── The three states, as three numbers ──────────────────────────────────────
 *   reveal  how much of the web is drawn — 0 to 1, centre outward, once, as the
 *           checking state opens. The web SPINS rather than appearing.
 *   fill    how much of it carries the verdict's colour — 0 while checking, and
 *           0 to 1 centre outward when a result lands.
 *   gems    a handful of sparkles flaring and respawning elsewhere, each
 *           lighting the lines it sits on. Blue while thinking; the verdict's
 *           colour in proportion to `fill`.
 *
 * `reveal` and `fill` share the edge ordering `buildWeb` fixes once — centre
 * first — so both travel the face the same way. That is deliberate: the verdict
 * is the same gesture as the arrival, finishing.
 *
 * ── ⚠️ It renders OUTSIDE `VerdictMark`'s phase key ─────────────────────────
 * `LivenessVerdict` keys the mark by phase so the verdict's own animations
 * replay from their first frame. This must NOT be inside that: remounting would
 * rebuild the mesh and replay the reveal at the moment the result lands, so the
 * face would appear to be scanned a second time instead of the wireframe it
 * already wears changing colour. It takes `phase` as a prop and times its own
 * transitions from when that prop changes.
 *
 * ── ⚠️ It cannot affect the check ───────────────────────────────────────────
 * Same as the live mesh: this is a canvas painted over a picture that has
 * already been submitted. Nothing reads these pixels back.
 */

/** The two verdict colours. Every mark in this flow takes them from here. */
export const VERDICT_PASS = '#34C759';
export const VERDICT_FAIL = '#FF3B30';

/**
 * The mesh at rest. WHITE — it is not blue.
 *
 * ⚠️ The blue is a thing that HAPPENS to the mesh, not what the mesh is. An
 * earlier version made the whole wireframe blue-white and the sparkles blue,
 * and the result was a flat blue mask: nothing could be seen to change, because
 * everything was already the colour of the change. A white mesh is what gives
 * the blue somewhere to arrive.
 */
const BASE = '#FFFFFF';

/**
 * The blue that travels with the glitter, and only with it.
 *
 * Every sparkle lights the LINES it sits on, in this, and they fade back to
 * white behind it. So the colour moves around the face in patches, in step with
 * the flares, rather than sitting on it — which is the difference between a
 * model working its way over a photograph and a photograph with a filter on it.
 */
const SPARK = '#5AA5FF';

/**
 * How many of the sparkles are a RUN OF LINES rather than a point of light.
 *
 * Not all glitter is a star. A third of it lights a short run of the web — the
 * lines meeting one point, and one hop beyond — going blue and fading back,
 * with no star drawn at all. That is what stops the field reading as nine lamps
 * on a grid: some of what flares is the geometry itself.
 */
const LINE_SHARE = 0.34;

/**
 * How long the web takes to spin, centre to rim, in ms.
 *
 * Slow enough to read as drawing and not as appearing; short enough to be over
 * well before a verdict can arrive, since a result landing mid-build would show
 * a colour sweep chasing a reveal up the same face.
 *
 * ⚠️ IT SETS A FLOOR ON THE WHOLE CHECKING STATE, which is the real reason to
 * keep it short. `MIN_CHECKING_MS` in `FaceLivenessScreen` exists to stop this
 * animation flashing past unseen, so it is derived from this number — and every
 * millisecond here is therefore a millisecond added to any run where the
 * servers answer quickly. 520 still reads as the web being spun rather than
 * switched on; the two move together, and that one points back here.
 */
const REVEAL_MS = 520;

/**
 * How long the verdict's colour takes to cross the face, in ms.
 *
 * Faster than the build. The wait is allowed to take its time; the answer is
 * not — a result that creeps up somebody's face reads as the check still
 * running.
 *
 * ⚠️ THESE THREE MUST SUM TO THE SCREEN'S GREEN HOLD, which is one second. See
 * the note on `MESH_HOLD_MS`.
 */
const SWEEP_MS = 420;

/**
 * ── ⚠️ ON A PASS, THE WEB LEAVES ─────────────────────────────────────────────
 * How long the finished green web is held, and how long it then takes to go.
 *
 * A pass is the END of the check, and the web is the thing that says a check is
 * happening. Leaving it up afterwards keeps the screen saying "being examined"
 * at the one moment it should be saying "done" — and it is drawn over the
 * person's face, which is the last place anybody wants a diagram once they have
 * been let through.
 *
 * So it holds long enough to be seen whole in green, then dissolves and hands
 * the frame back to the face. The light out of the mark and the green ring on
 * the frame carry the verdict from there; those belong to the frame and are
 * supposed to outlive the web.
 *
 * ⚠️ ONLY ON A PASS. A refusal keeps its web for the whole two seconds it is
 * shown — the red geometry ON the face is what makes it read as "your face was
 * not accepted" rather than as the app having broken — and `LivenessVerdict`
 * takes the whole frame away at `FAIL_HOLD_MS` anyway.
 *
 * ⚠️ NOT the screen's `PASS_HOLD_MS`, which is a different thing in
 * `FaceLivenessScreen`: how long the whole green verdict is held before the
 * commit navigates away. They are named apart on purpose and they are TIED
 * TOGETHER BY ARITHMETIC:
 *
 *     SWEEP_MS + MESH_HOLD_MS + MESH_FADE_MS  =  PASS_HOLD_MS
 *     420      + 180          + 400           =  1000
 *
 * The screen navigates the instant its hold ends, so anything left unfinished
 * here is simply cut off — a green sweep that never arrives, or a dissolve that
 * vanishes at half opacity. ⚠️ CHANGE ONE SIDE AND CHANGE THE OTHER. The same
 * warning sits beside `PASS_HOLD_MS`.
 *
 * At one second the whole verdict is tight but complete: the green crosses the
 * face, is seen whole for a beat, and is gone as the screen moves.
 */
const MESH_HOLD_MS = 180;
const MESH_FADE_MS = 400;

/** Ease-out cubic. Fast at the start, settling — an arrival, not a crossing. */
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export function VerdictMesh({
    phase,
    mesh,
}: {
    phase: 'checking' | 'passed' | 'failed';
    /** The wireframe read out of the still — see `useStillMesh`. */
    mesh: StillMesh;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    /*
     * The phase, and the moment it last changed, for a loop that captured its
     * closure once. Written in an effect, never during render — a ref assigned
     * in the component body keeps a value from work that may never commit.
     */
    const phaseRef = useRef(phase);
    const phaseAtRef = useRef(0);
    const meshRef = useRef(mesh);

    useEffect(() => {
        meshRef.current = mesh;
    }, [mesh]);

    useEffect(() => {
        phaseRef.current = phase;
        phaseAtRef.current = performance.now();
    }, [phase]);

    useEffect(() => {
        const {
            lineWidth,
            baseAlpha,
            dotCount,
            dotMinLifeMs,
            dotMaxLifeMs,
            dotRadius,
            maxDpr,
            rimBreak,
        } = CAPTURE_LIVE_MESH;

        /*
         * Reduced motion: no build, no sweep, no gems — the mesh is simply
         * there, in the colour the phase calls for. Both end states are
         * legible still frames, which is the requirement; the information is
         * in the colour, and only the delivery of it was ever motion.
         */
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        /**
         * One sparkle: where it is, when it appeared, how long it lives, and
         * WHICH EDGES it lights while it does.
         *
         * `edges` is the run of the mesh that goes blue with it — the lines
         * meeting its vertex, plus one hop further for the ones that are a run
         * rather than a point. Resolved at birth, not per frame: it is the same
         * run for the sparkle's whole life, and recomputing it would be work
         * done sixty times a second to get the same answer.
         */
        interface Gem {
            at: number;
            /** No star drawn — this one IS the lines. See `LINE_SHARE`. */
            line: boolean;
            /** Carries the verdict's colour rather than the blue. */
            hot: boolean;
            born: number;
            life: number;
            edges: number[];
        }
        const gems: Gem[] = [];

        /**
         * Which edges meet each vertex — built once per mesh, not per frame.
         *
         * The wireframe is a flat list of endpoint pairs, so "the lines that
         * touch this point" is a question it cannot answer without a scan. A
         * sparkle asks it every time one is born.
         */
        let incidence: Map<number, number[]> | null = null;
        let incidenceFor: unknown = null;

        let frame = 0;

        const draw = (now: number) => {
            frame = requestAnimationFrame(draw);

            const canvas = canvasRef.current;
            const { web, natural } = meshRef.current;
            if (!canvas || !web || !natural) return;

            /*
             * Sized to the element's CSS box every frame, because the frame is
             * responsive: XD-pixel scaling changes this box's size in real
             * pixels on a window resize without React re-rendering anything.
             */
            const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
            const cssW = canvas.clientWidth;
            const cssH = canvas.clientHeight;
            if (!cssW || !cssH) return;
            const w = Math.round(cssW * dpr);
            const h = Math.round(cssH * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, w, h);

            // The picture is `object-fit: cover`; the web's points are
            // normalised over the whole image. See `coverCrop`.
            const { sx, sy, sw, sh } = coverCrop(natural.w, natural.h, cssW, cssH);
            const verts = web.verts;
            const px = (i: number) => ((verts[i * 2] * natural.w - sx) / sw) * w;
            const py = (i: number) => ((verts[i * 2 + 1] * natural.h - sy) / sh) * h;

            const decided = phaseRef.current !== 'checking';
            const elapsed = now - phaseAtRef.current;

            /*
             * Both are shares of the SAME chin-first edge list, so the build and
             * the verdict travel the face the same way. `still` (reduced motion)
             * skips straight to the end state of each: the mesh is fully drawn
             * and fully coloured, which is the legible still frame.
             */
            const reveal =
                still || decided ? 1 : ease(Math.min(1, elapsed / REVEAL_MS));
            const fill = !decided ? 0 : still ? 1 : ease(Math.min(1, elapsed / SWEEP_MS));

            /*
             * The web's own opacity, and the only thing that ever reduces it.
             * See `MESH_HOLD_MS` — a pass is the end of the check, so the web
             * goes once it has been seen finished.
             *
             * ⚠️ Not under reduced motion. There is no green sweep there to be
             * "after", and the still frame that announces a pass is the green
             * web itself; dissolving it would leave that state with nothing on
             * the face at all.
             */
            const leaving =
                phaseRef.current === 'passed' && !still
                    ? 1 -
                      Math.min(
                          1,
                          Math.max(0, elapsed - SWEEP_MS - MESH_HOLD_MS) / MESH_FADE_MS,
                      )
                    : 1;
            // Gone. Nothing to draw, and the canvas was cleared above.
            if (leaving <= 0) return;
            ctx.globalAlpha = leaving;

            const pairs = web.edges;
            // Rounded to whole EDGES — an odd index would pair one vertex with
            // the next edge's and draw a line across the face.
            const drawn = Math.floor((reveal * pairs.length) / 2) * 2;
            const lit = Math.floor((fill * drawn) / 2) * 2;

            const hot = phaseRef.current === 'passed' ? VERDICT_PASS : VERDICT_FAIL;

            /**
             * @param inset How far short of each end to stop, in device px.
             *   Used on the rim, so the boundary breaks where a spoke arrives —
             *   see `rimBreak`. The vertices do not move; only the ink stops.
             */
            const strokeRange = (
                from: number,
                to: number,
                colour: string,
                width: number,
                inset = 0,
            ) => {
                if (to <= from) return;
                ctx.beginPath();
                for (let e = from; e < to; e += 2) {
                    const a = pairs[e];
                    const b = pairs[e + 1];
                    let ax = px(a);
                    let ay = py(a);
                    let bx = px(b);
                    let by = py(b);
                    if (inset > 0) {
                        const len = Math.hypot(bx - ax, by - ay);
                        // A segment shorter than two insets would invert; leave
                        // those whole rather than drawing them backwards.
                        if (len > inset * 2.4) {
                            const ux = ((bx - ax) / len) * inset;
                            const uy = ((by - ay) / len) * inset;
                            ax += ux;
                            ay += uy;
                            bx -= ux;
                            by -= uy;
                        }
                    }
                    ctx.moveTo(ax, ay);
                    ctx.lineTo(bx, by);
                }
                ctx.strokeStyle = colour;
                ctx.lineWidth = width;
                ctx.stroke();
            };

            /** The same, for an arbitrary set of edges rather than a run. */
            const strokeSome = (list: number[], colour: string, width: number) => {
                if (!list.length) return;
                ctx.beginPath();
                for (const e of list) {
                    const a = pairs[e];
                    const b = pairs[e + 1];
                    ctx.moveTo(px(a), py(a));
                    ctx.lineTo(px(b), py(b));
                }
                ctx.strokeStyle = colour;
                ctx.lineWidth = width;
                ctx.stroke();
            };

            /*
             * `miter` joins and `butt` caps: `round` is what made this read as
             * soft tubing instead of geometry, because it rounds off every
             * corner — and the corners are what it is made of.
             */
            ctx.lineJoin = 'miter';
            ctx.miterLimit = 6;
            ctx.lineCap = 'butt';

            const hair = Math.max(1, lineWidth * dpr);

            /*
             * ── Two passes per range, and the wide one is the whole point ────
             *
             * ⚠️ EVERY STRENGTH HERE IS A MULTIPLE OF `baseAlpha` or a fraction
             * written out below, and they were all taken down together once the
             * web replaced the old tracery: 108 lines at 1.6px carry nearly
             * three times the ink of 1300 hairlines at 0.6px, so the values that
             * made threads legible made cords shout. If one of them is ever
             * raised on its own the web stops reading as one material.
             *
             * A thin line at 0.22 alpha is close to invisible over frosted
             * glass, which is what the checking state puts behind it. The
             * verdict has the opposite problem: a green thread is not an
             * announcement.
             *
             * So each range is stroked twice — once wide and faint for a glow
             * the colour can carry, once thin and bright for the geometry. Two
             * stroke calls over one path each; `shadowBlur` would be a per-draw
             * blur pass over ~1300 segments and is the most expensive thing
             * that could be asked for on this screen.
             */
            /*
             * ── ⚠️ EXCEPT ON THE RIM, WHICH GETS NO GLOW ────────────────────
             *
             * The wide pass is what makes a line soft: a 3x-width stroke under
             * a hairline, so every line carries a halo. The interior needs it
             * to survive frosted glass. A BOUNDARY must not have it — a line
             * with a soft skirt either side does not read as an edge, it reads
             * as a blur.
             *
             * ⚠️ SAME COLOUR, SAME ALPHA, NO HALO — the rim is not brightened.
             * It was, and that was wrong: painting the edge louder does not
             * make it sharper, it makes it louder, and the boundary stopped
             * belonging to the same web as the weave inside it. The rim is
             * legible because of its SHAPE — every corner is a real angle, see
             * the zig note in `buildWeb` — and all this does is stop a blur
             * being drawn over it.
             */
            const rim = web.rim;
            /*
             * The rim is drawn as its own range so it can be both un-haloed and
             * INSET — stopping short of every spoke, which is the break. See
             * `rimBreak`.
             */
            const gap = rimBreak * dpr;

            strokeRange(lit, Math.min(drawn, rim), withAlpha(BASE, baseAlpha * 0.45), hair * 3);
            strokeRange(lit, Math.min(drawn, rim), withAlpha(BASE, baseAlpha * 1.5), hair);
            strokeRange(Math.max(lit, rim), drawn, withAlpha(BASE, baseAlpha * 1.5), hair, gap);

            strokeRange(0, Math.min(lit, rim), withAlpha(hot, 0.2), hair * 3.6);
            strokeRange(0, Math.min(lit, rim), withAlpha(hot, 0.62), hair);
            strokeRange(rim, lit, withAlpha(hot, 0.62), hair, gap);

            /*
             * ⚠️ NOT UNTIL THE WEB IS WHOLE. A sparkle sits on a VERTEX, and
             * until the spin reaches it there is no line there to sit on — so a
             * sparkle during the reveal is a speck of light flaring on bare
             * forehead. Waiting also separates the two events: the web arrives,
             * and then it is alive.
             */
            if (still || reveal < 1) return;

            /*
             * ── The gems ────────────────────────────────────────────────────
             *
             * Each lives for its own span, then RESPAWNS on a different vertex.
             * There is no path and no travel: it is here, then it is gone, then
             * a different one is somewhere else. That discontinuity is the
             * whole difference between a sparkle and a thread.
             */
            const nodes = web.vertices;
            const pick = () => nodes[Math.floor(Math.random() * nodes.length)];

            // Rebuilt only when the mesh itself changes — see `incidence`.
            if (incidenceFor !== web.edges) {
                incidenceFor = web.edges;
                incidence = new Map();
                for (let e = 0; e < pairs.length; e += 2) {
                    for (const v of [pairs[e], pairs[e + 1]]) {
                        const list = incidence.get(v);
                        if (list) list.push(e);
                        else incidence.set(v, [e]);
                    }
                }
            }
            const meets = (v: number) => incidence?.get(v) ?? [];

            /**
             * The run of lines one sparkle lights.
             *
             * A point of light takes the lines meeting its own vertex — the
             * triangles it sits in. A RUN takes those plus the ones meeting the
             * far end of one of them, so the blue travels two or three
             * triangles across the face instead of haloing a single point.
             */
            const runFrom = (v: number, long: boolean): number[] => {
                const first = meets(v);
                if (!long || !first.length) return first;
                const e = first[Math.floor(Math.random() * first.length)];
                const far = pairs[e] === v ? pairs[e + 1] : pairs[e];
                return [...new Set([...first, ...meets(far)])];
            };

            const spawn = (gem: Partial<Gem> = {}): Gem => {
                const at = pick();
                const line = Math.random() < LINE_SHARE;
                return {
                    at,
                    line,
                    // Decided at BIRTH and never changed. One that changed
                    // colour mid-flare would draw the eye to the change rather
                    // than to the sparkle, and it is the PROPORTION that
                    // carries the meaning anyway.
                    hot: Math.random() < fill,
                    born: now,
                    life: dotMinLifeMs + Math.random() * (dotMaxLifeMs - dotMinLifeMs),
                    edges: runFrom(at, line),
                    ...gem,
                };
            };

            while (gems.length < dotCount) {
                // Staggered into the PAST, so the first set is already mid-life
                // at different points rather than all nine flaring together on
                // the frame this opens.
                gems.push(spawn({ born: now - Math.random() * dotMaxLifeMs }));
            }

            const core = dotRadius * dpr;

            /*
             * ── The blue, and where it comes from ───────────────────────────
             *
             * Every sparkle lights its own run of the mesh, and the lines fade
             * back to white behind it. Drawn BEFORE the stars so a star sits on
             * top of the light it is throwing, and in one pass per sparkle over
             * half a dozen edges — nothing here is near the cost of the base
             * mesh's own two strokes.
             *
             * ⚠️ The colour follows the phase, not the sparkle's job: blue
             * while a model is looking, the verdict's colour once it has
             * answered. A blue flare crossing a green mesh would be a second
             * opinion arriving after the decision.
             */
            for (const gem of gems) {
                const t = (now - gem.born) / gem.life;
                if (t >= 1 || !gem.edges.length) continue;
                const flare = Math.pow(Math.sin(t * Math.PI), 1.6);
                if (flare < 0.02) continue;
                const colour = gem.hot ? hot : SPARK;
                strokeSome(gem.edges, withAlpha(colour, 0.24 * flare), hair * 3.2);
                strokeSome(gem.edges, withAlpha(colour, 0.66 * flare), hair);
            }

            for (const gem of gems) {
                const t = (now - gem.born) / gem.life;
                if (t >= 1) {
                    Object.assign(gem, spawn());
                    continue;
                }

                // A run of lines IS the sparkle — no star over it. See
                // `LINE_SHARE`.
                if (gem.line) continue;

                /*
                 * In, flare, out. `^1.6` on a half-sine keeps each one dark for
                 * most of its life and bright only briefly — a plain sine sits
                 * near full brightness for half its cycle, which makes nine
                 * gems look like nine lamps that are simply on.
                 */
                const flare = Math.pow(Math.sin(t * Math.PI), 1.6);
                if (flare < 0.02) continue;

                const gx = px(gem.at);
                const gy = py(gem.at);

                /*
                 * The halo — and it is the COLOURED part of a star, while the
                 * point itself stays white. That is the same division the lines
                 * make: white geometry, colour in the light coming off it.
                 *
                 * Two draws rather than `shadowBlur`, which is a per-draw blur
                 * pass and the most expensive thing that could be asked for on
                 * this screen.
                 */
                const glow = gem.hot ? hot : SPARK;
                const halo = ctx.createRadialGradient(gx, gy, 0, gx, gy, core * 4);
                halo.addColorStop(0, withAlpha(glow, 0.4 * flare));
                halo.addColorStop(1, withAlpha(glow, 0));
                ctx.fillStyle = halo;
                ctx.beginPath();
                ctx.arc(gx, gy, core * 4, 0, Math.PI * 2);
                ctx.fill();

                /*
                 * The gem itself — a four-pointed star, not a disc. The long
                 * thin points are what make a highlight read as faceted; a
                 * round dot of light reads as a lens flare or a dead pixel.
                 * Scaled by the flare so it grows as it brightens.
                 *
                 * White at the core even when the verdict is coloured: this is
                 * the specular point, and a highlight is the one place the
                 * colour is allowed to blow out. Its halo above carries the
                 * hue.
                 */
                const arm = core * (1 + flare * 2.6);
                ctx.beginPath();
                ctx.moveTo(gx, gy - arm);
                ctx.lineTo(gx + core * 0.36, gy - core * 0.36);
                ctx.lineTo(gx + arm, gy);
                ctx.lineTo(gx + core * 0.36, gy + core * 0.36);
                ctx.lineTo(gx, gy + arm);
                ctx.lineTo(gx - core * 0.36, gy + core * 0.36);
                ctx.lineTo(gx - arm, gy);
                ctx.lineTo(gx - core * 0.36, gy - core * 0.36);
                ctx.closePath();
                ctx.fillStyle = gem.hot
                    ? withAlpha(hot, 0.28 + 0.44 * flare)
                    : `rgba(255, 255, 255, ${0.22 + 0.5 * flare})`;
                ctx.fill();
            }
        };

        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            /*
             * Above the glass, not under it. The checking state's whole idea is
             * a face nobody can study; the wireframe is the one thing on that
             * pane that must stay sharp.
             *
             * Mirrored with the picture it lies on — the landmarks were read
             * from the UNMIRRORED still, exactly as the live mesh reads them
             * from the unmirrored stream, so the overlay takes the same flip
             * the <img> does or it lands on the wrong side of the face.
             */
            className={`pointer-events-none absolute inset-0 h-full w-full ${MIRROR_CLASS}`}
        />
    );
}

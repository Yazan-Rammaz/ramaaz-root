'use client';

import { useEffect, useRef } from 'react';

import {
    CAPTURE_LIVE_MESH,
    CAPTURE_MESH_FILL,
    CAPTURE_MIRROR,
} from '@/features/kyc/config/capture';
import { useFaceLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';
import {
    buildWeb,
    coverCrop,
    ringOrder,
    withAlpha,
    type Edges,
    type Web,
} from '@/features/kyc/services/faceMesh';

/**
 * The face web over the live camera, lit like the rest of this flow.
 *
 * ── What it draws ───────────────────────────────────────────────────────────
 * A spider's web spun from the middle of the face out to its own outline, drawn
 * STEADY — plus a handful of gems that sit on its vertices, flare, fade, and
 * come back somewhere else. The geometry holds still; only the gems move, and
 * they move by appearing and disappearing rather than by travelling.
 *
 * ⚠️ IT IS NOT MEDIAPIPE'S TESSELLATION. It was, clustered down to a readable
 * size, and that could never be made to look regular or symmetric — a pattern
 * inferred from where one face's landmarks happen to be inherits their
 * irregularity. `services/faceMesh` carries the full account and the geometry;
 * this file draws what that returns.
 *
 * ── ⚠️ IT CANNOT AFFECT THE CHECK, and that is structural ───────────────────
 * AWS streams the MediaStream TRACK to Rekognition and runs its face-fit test
 * against the stream's own geometry. This is a sibling canvas painting over the
 * top; neither reads it. The capture is `drawImage` on AWS's video element,
 * which reads the decoded frame and ignores everything painted over it. Same
 * separation as the live glass and the retouched preview. Any change that lets
 * these pixels feed back into the check is a security regression, not a visual
 * one.
 *
 * ── The two clocks ──────────────────────────────────────────────────────────
 * The model runs at `detectFps`; the canvas draws on every animation frame. In
 * between, the landmarks EASE toward the newest ones and the web is respun on
 * them, so it moves at the display's rate while the network runs at a fraction
 * of it. Running detection per frame would not even look better — the model's
 * own output jitters, and the same filter that fills the gaps is what takes
 * that out.
 *
 * ── Two things that were tried and are wrong ────────────────────────────────
 * Both are recorded because each looked obviously right before it was drawn.
 *
 * CHAINING the tessellation into long paths, so a dashed stroke could run along
 * them. A greedy walk through a triangulation wanders, and thinning the runs by
 * dropping vertices cut across the triangles they came from — so the "mesh"
 * became a few hundred zigzag threads over somebody's face.
 *
 * DASHES as the moving light. A dash travelling a path is the line being drawn
 * in pieces, so it always reads as thread, never as a spark. A gem appears,
 * shines, and is gone somewhere else; only discrete points with their own
 * lifetimes do that.
 */

/*
 * The geometry — `buildWeb`, the outline walk and the cover crop — lives in
 * `services/faceMesh`, because the verdict screen draws the SAME web over the
 * frozen frame (`VerdictMesh`). Two copies of it would agree until one was
 * tuned, and the failure would be a web that changed shape at the moment the
 * camera stopped.
 */

/** One gem: which vertex it sits on, when it appeared, and how long it lives. */
interface Gem {
    at: number;
    /** Green once the match bar has filled this far — decided at birth. */
    green: boolean;
    born: number;
    life: number;
}

export function FaceMesh({
    videoRef,
    canvasRef,
    matchRef,
    onBounds,
    hidden = false,
}: {
    /**
     * AWS's own <video>. Owned by `LivenessCamera`'s sampling loop, which is
     * the only thing that can find it — the element is created inside the
     * detector's tree and appears asynchronously.
     */
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /**
     * The wireframe's own bounding box, in the frame's 0..1 space, reported on
     * every detection.
     *
     * Exists so the glass oval can be exactly the mesh's footprint. Measuring
     * it anywhere else would mean a second estimate of where the face is, and
     * two estimates drift — the pane would sit slightly off the wireframe it is
     * supposed to be behind, which is the one error that cannot be hidden.
     */
    /**
     * The canvas, owned by the caller.
     *
     * The viewfinder's zoom transforms the video, the glass and this together —
     * they share one coordinate space, so scaling any of them alone tears the
     * overlay off the face it describes. That makes the element the caller's to
     * move.
     */
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    /**
     * How full AWS's match bar is, 0..1 — read from their own DOM by the
     * caller.
     *
     * A share of the wireframe equal to this turns green, from the chin upward.
     * Their number rather than ours: a gauge that disagreed with the hint
     * beside it would be worse than no gauge.
     */
    matchRef: React.RefObject<number>;
    onBounds?: (b: { cx: number; cy: number; rx: number; ry: number }) => void;
    /**
     * Fade the tracery out, without stopping anything behind it.
     *
     * Set while the frame is too dark or too soft to see a face in. The mesh is
     * drawn FROM landmarks, so on a frame nobody can make a face out in it is
     * either wrong — a wireframe hung on noise, jittering over a black
     * rectangle — or, worse, convincing: it says the camera can see you at the
     * exact moment the screen is telling you it cannot. That contradiction is
     * what this removes.
     *
     * Only the canvas is faded. Detection, `onBounds` and the glass placement
     * that depends on it keep running — see the note at the style.
     */
    hidden?: boolean;
}) {
    const { detect, isReady } = useFaceLandmarker();

    /**
     * Kept current for a loop that captured its closure once.
     *
     * The draw effect below has `[]` deps deliberately — it owns an animation
     * frame and the gems' lifetimes, and tearing those down whenever a parent
     * re-renders would restart every twinkle. So these are read through refs
     * instead of from the closure.
     *
     * ⚠️ Written in an EFFECT, never during render. A ref assignment in the
     * component body is a lint error here (`react-hooks/refs`) and a real one:
     * with React's concurrent rendering a render can be thrown away, and a ref
     * written during it keeps a value from work that never committed.
     */
    const readyRef = useRef(isReady);
    const detectRef = useRef(detect);
    const boundsRef = useRef(onBounds);

    useEffect(() => {
        readyRef.current = isReady;
    }, [isReady]);

    useEffect(() => {
        detectRef.current = detect;
    }, [detect]);

    useEffect(() => {
        boundsRef.current = onBounds;
    }, [onBounds]);

    /**
     * Where the mesh IS and where it is HEADED, as flat x,y pairs in the
     * element's own 0..1 space.
     *
     * Flat `Float32Array`s rather than arrays of points: this is read and
     * written 60 times a second across ~950 numbers, and the allocation churn
     * of rebuilding point objects per frame is the kind of cost that only shows
     * up as jank on the device that can least afford it.
     */
    const targetRef = useRef<Float32Array | null>(null);
    const currentRef = useRef<Float32Array | null>(null);
    const seenRef = useRef(false);
    const lastDetectRef = useRef(0);

    /**
     * The face's outline as an ordered ring, fetched once from the module the
     * hook already loaded. The web is spun out to THIS — see `buildWeb`.
     */
    const ringRef = useRef<number[] | null>(null);
    /**
     * The web actually drawn.
     *
     * ⚠️ REBUILT EVERY FRAME, unlike the clustered mesh it replaces, which was
     * built once and then carried by easing the landmarks under it. It has to
     * be: the web's points are not landmarks, they are where a spoke crosses a
     * ring, so they move whenever the outline does. Rebuilding is ~600 segment
     * tests against a 36-point outline, which is nothing beside the detection
     * that already runs here — and `buildWeb` writes back into this same object
     * rather than allocating.
     */
    const webRef = useRef<Web | null>(null);
    const gemsRef = useRef<Gem[]>([]);
    /** The fill, eased toward `matchRef` — see `CAPTURE_MESH_FILL.smoothing`. */
    const fillRef = useRef(0);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const { FaceLandmarker: L } = await import('@mediapipe/tasks-vision');
                if (cancelled) return;
                ringRef.current = ringOrder(L.FACE_LANDMARKS_FACE_OVAL as Edges);
            } catch {
                // Nothing to draw without the outline. The overlay stays
                // empty, which is what it does before the model loads anyway —
                // no error state is worth showing for a decoration.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!CAPTURE_LIVE_MESH.enabled) return;

        let frame = 0;
        const {
            detectFps,
            smoothing,
            lineWidth,
            baseAlpha,
            dotCount,
            dotMinLifeMs,
            dotMaxLifeMs,
            dotRadius,
            maxDpr,
            rimBreak,
        } = CAPTURE_LIVE_MESH;
        const detectEvery = 1000 / detectFps;

        /**
         * The last distinct frame the preview showed, and when it showed it.
         *
         * ⚠️ THE WIREFRAME MUST NOT OUTLIVE THE PICTURE IT DESCRIBES. When the
         * stream ends, AWS's <video> keeps its dimensions and simply stops
         * advancing — so every test based on the ELEMENT still passes while the
         * frame is black, and the mesh carries on being drawn on the last
         * landmarks it had. That is the black rectangle with a face-shaped
         * wireframe floating in it, and it reads as a crash at the exact moment
         * somebody's face was taken.
         *
         * Shorter than `FRAMES_STALLED_MS` in LivenessCamera on purpose: the
         * mesh has to be gone BEFORE the checking state arrives, never after.
         */
        const STALL_MS = 300;
        let lastShown = -1;
        let lastShownAt = 0;

        const draw = (now: number) => {
            frame = requestAnimationFrame(draw);

            const canvas = canvasRef.current;
            if (!canvas) return;
            /* Clearing, not merely returning: an early return leaves the last
               frame painted, which is the whole failure above. */
            const wipe = () =>
                canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);

            const video = videoRef.current;
            if (!video?.videoWidth) {
                wipe();
                return;
            }

            const shown = video.currentTime;
            if (shown !== lastShown) {
                lastShown = shown;
                lastShownAt = now;
            }
            if (lastShownAt > 0 && now - lastShownAt > STALL_MS) {
                wipe();
                return;
            }

            /*
             * Size to the element's CSS box, capped. Read every frame because
             * the frame is responsive — the XD-pixel scale means a window
             * resize changes this box's size in real pixels without React
             * re-rendering anything here.
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

            /*
             * ── The cover crop ──────────────────────────────────────────────
             *
             * Landmarks are normalised over the VIDEO, and the frame shows an
             * `object-fit: cover` crop of it — a 4:3 stream in a 350x400 box
             * loses a third of its width before anything is seen. Mapping
             * straight from 0..1 to the canvas would put the mesh on a face
             * that is not where the mesh thinks it is, stretched by the same
             * ratio. Same arithmetic as `drawProbe` in LivenessCamera, and the
             * same helper the still mesh uses — see `coverCrop`.
             */
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const { sx, sy, sw, sh } = coverCrop(vw, vh, cssW, cssH);

            // ── The model, on its own clock ─────────────────────────────────
            if (readyRef.current && now - lastDetectRef.current >= detectEvery) {
                lastDetectRef.current = now;
                try {
                    const mesh = detectRef.current(video)?.faceLandmarks?.[0];
                    if (mesh?.length) {
                        const target = (targetRef.current ??= new Float32Array(
                            mesh.length * 2,
                        ));
                        for (let i = 0; i < mesh.length; i++) {
                            target[i * 2] = (mesh[i].x * vw - sx) / sw;
                            target[i * 2 + 1] = (mesh[i].y * vh - sy) / sh;
                        }
                        /*
                         * The FIRST landmarks are taken whole rather than eased
                         * into. Easing from an all-zero buffer would fly the
                         * mesh in from the top-left corner of the frame over
                         * about half a second, every time a face is found.
                         */
                        /*
                         * The mesh's extent, for the glass behind it. Reported
                         * from the TARGET rather than the eased positions: the
                         * pane has its own CSS easing, and easing an already
                         * eased value lags twice as far behind a moving face.
                         */
                        let bx0 = Infinity;
                        let by0 = Infinity;
                        let bx1 = -Infinity;
                        let by1 = -Infinity;
                        for (let i = 0; i < target.length; i += 2) {
                            if (target[i] < bx0) bx0 = target[i];
                            if (target[i] > bx1) bx1 = target[i];
                            if (target[i + 1] < by0) by0 = target[i + 1];
                            if (target[i + 1] > by1) by1 = target[i + 1];
                        }
                        boundsRef.current?.({
                            cx: (bx0 + bx1) / 2,
                            cy: (by0 + by1) / 2,
                            rx: (bx1 - bx0) / 2,
                            ry: (by1 - by0) / 2,
                        });

                        if (!seenRef.current) {
                            currentRef.current = target.slice();
                            seenRef.current = true;
                        }
                    }
                } catch {
                    // A frame the model would not take — a timestamp that did
                    // not advance, a lost GPU context. Keep the last mesh and
                    // try again on the next tick.
                }
            }

            const target = targetRef.current;
            const cur = currentRef.current;
            const ring = ringRef.current;
            if (!target || !cur || !ring?.length) return;

            // ── Ease toward the latest landmarks ────────────────────────────
            for (let i = 0; i < cur.length; i++) {
                cur[i] += (target[i] - cur[i]) * smoothing;
            }

            /*
             * ── The web, respun on the eased landmarks ──────────────────────
             *
             * Rebuilt every frame rather than carried: its points are spoke-on-
             * ring crossings, not landmarks, so they move whenever the outline
             * does. `webRef.current` is passed back in so the positions are
             * written into the array that already exists — see `buildWeb`.
             */
            const web = buildWeb(cur, ring, CAPTURE_LIVE_MESH, webRef.current ?? undefined);
            if (!web) return;
            webRef.current = web;
            const { edges: pairs, vertices: nodes, verts } = web;

            /*
             * ── How much of the mesh is green ───────────────────────────────
             *
             * Eased toward AWS's bar, and applied as a SHARE OF THE LINES
             * rather than as a tint over all of them. The eye counts how much
             * has changed, which is a quantity; blending every line toward
             * green says the same thing in a way nobody can read a value off.
             *
             * `pairs` runs from the centre outward (see `buildWeb`), so the
             * web fills from the middle of the face out to its edge.
             */
            const want = CAPTURE_MESH_FILL.enabled ? (matchRef.current ?? 0) : 0;
            fillRef.current += (want - fillRef.current) * CAPTURE_MESH_FILL.smoothing;
            // Rounded to a whole EDGE — an odd index would pair one vertex with
            // the next edge's and draw a line across the face.
            const lit = Math.floor((fillRef.current * pairs.length) / 2) * 2;

            /**
             * @param inset How far short of each end to stop, in device px.
             *   Used on the rim, so the boundary breaks where a spoke arrives —
             *   see `rimBreak`. The vertices do not move; only the ink stops.
             */
            const strokeRange = (from: number, to: number, colour: string, inset = 0) => {
                if (to <= from) return;
                ctx.beginPath();
                for (let e = from; e < to; e += 2) {
                    const a = pairs[e] * 2;
                    const b = pairs[e + 1] * 2;
                    let ax = verts[a] * w;
                    let ay = verts[a + 1] * h;
                    let bx = verts[b] * w;
                    let by = verts[b + 1] * h;
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
                ctx.stroke();
            };

            /*
             * `miter` joins and `butt` caps: `round` is what made this read as
             * soft tubing instead of geometry, because it takes the corner off
             * every triangle — and the corners are what it is made of.
             */
            ctx.lineJoin = 'miter';
            ctx.miterLimit = 6;
            ctx.lineCap = 'butt';
            ctx.lineWidth = Math.max(1, lineWidth * dpr);

            /*
             * The filled part is BRIGHTER as well as greener. At this alpha on
             * a moving camera a hue change alone is close to invisible — the
             * mesh would appear to do nothing while the bar filled.
             */
            const rim = web.rim;
            // The rim stops short of every spoke — the break. See `rimBreak`.
            const gap = rimBreak * dpr;

            strokeRange(0, Math.min(lit, rim), withAlpha(CAPTURE_MESH_FILL.colour, baseAlpha * 2.1));
            strokeRange(rim, lit, withAlpha(CAPTURE_MESH_FILL.colour, baseAlpha * 2.1), gap);
            strokeRange(lit, Math.min(pairs.length, rim), `rgba(255, 255, 255, ${baseAlpha})`);
            strokeRange(Math.max(lit, rim), pairs.length, `rgba(255, 255, 255, ${baseAlpha})`, gap);

            /*
             * ⚠️ THE RIM IS NOT PAINTED DIFFERENTLY, and it was for a while.
             * Re-stroking the boundary brighter is the obvious way to make it
             * read, and it is the wrong one: a louder line is not a sharper
             * one, and an edge picked out in paint stops belonging to the web
             * it encloses. The rim is legible because every corner of it is a
             * real angle — see the zig note in `buildWeb`. Same colour, same
             * weight, different shape.
             */

            /*
             * ── The gems ────────────────────────────────────────────────────
             *
             * Each lives for its own span, then RESPAWNS on a different vertex.
             * There is no path and no travel: it is here, then it is gone, then
             * a different one is somewhere else. That discontinuity is the
             * whole difference between a sparkle and a thread.
             *
             * `Math.random()` for both the vertex and the lifetime — the ask is
             * "seemingly random", and anything derived from a clock produces a
             * pattern the eye finds within a few seconds.
             */
            const gems = gemsRef.current;
            /** A vertex of the DRAWN mesh — see `Coarse.vertices`. */
            const pick = () => nodes[Math.floor(Math.random() * nodes.length)];
            while (gems.length < dotCount) {
                gems.push({
                    at: pick(),
                    // Decided at BIRTH and never changed. One that turned green
                    // mid-flare would draw the eye to the change rather than to
                    // the sparkle, and it is the PROPORTION that carries the
                    // meaning anyway.
                    green: Math.random() < fillRef.current,
                    // Staggered into the PAST, so the first set is already
                    // mid-life at different points rather than all nine
                    // flaring together on the frame the camera opens.
                    born: now - Math.random() * dotMaxLifeMs,
                    life: dotMinLifeMs + Math.random() * (dotMaxLifeMs - dotMinLifeMs),
                });
            }

            const core = dotRadius * dpr;
            for (const gem of gems) {
                const t = (now - gem.born) / gem.life;
                if (t >= 1) {
                    gem.at = pick();
                    gem.green = Math.random() < fillRef.current;
                    gem.born = now;
                    gem.life =
                        dotMinLifeMs + Math.random() * (dotMaxLifeMs - dotMinLifeMs);
                    continue;
                }

                /*
                 * In, flare, out. `^1.6` on a half-sine keeps each one dark for
                 * most of its life and bright only briefly — a plain sine sits
                 * near full brightness for half its cycle, which makes nine
                 * gems look like nine lamps that are simply on.
                 */
                const flare = Math.pow(Math.sin(t * Math.PI), 1.6);
                if (flare < 0.02) continue;

                const px = verts[gem.at * 2] * w;
                const py = verts[gem.at * 2 + 1] * h;

                // The halo. Two draws rather than `shadowBlur`, which is a
                // per-draw blur pass and the most expensive thing that could be
                // asked for on this screen.
                const halo = ctx.createRadialGradient(px, py, 0, px, py, core * 4);
                halo.addColorStop(
                    0,
                    gem.green
                        ? withAlpha(CAPTURE_MESH_FILL.colour, 0.5 * flare)
                        : `rgba(210, 235, 255, ${0.5 * flare})`,
                );
                halo.addColorStop(1, 'rgba(160, 200, 255, 0)');
                ctx.fillStyle = halo;
                ctx.beginPath();
                ctx.arc(px, py, core * 4, 0, Math.PI * 2);
                ctx.fill();

                /*
                 * The gem itself — a four-pointed star, not a disc. The long
                 * thin points are what make a highlight read as faceted; a
                 * round dot of light reads as a lens flare or a dead pixel.
                 * Scaled by the flare so it grows as it brightens.
                 */
                const arm = core * (1 + flare * 2.6);
                ctx.beginPath();
                ctx.moveTo(px, py - arm);
                ctx.lineTo(px + core * 0.36, py - core * 0.36);
                ctx.lineTo(px + arm, py);
                ctx.lineTo(px + core * 0.36, py + core * 0.36);
                ctx.lineTo(px, py + arm);
                ctx.lineTo(px - core * 0.36, py + core * 0.36);
                ctx.lineTo(px - arm, py);
                ctx.lineTo(px - core * 0.36, py - core * 0.36);
                ctx.closePath();
                ctx.fillStyle = gem.green
                    ? withAlpha(CAPTURE_MESH_FILL.colour, 0.3 + 0.7 * flare)
                    : `rgba(255, 255, 255, ${0.25 + 0.75 * flare})`;
                ctx.fill();
            }
        };

        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
        // All three are REFS, whose identity is stable for the component's
        // life — listing them changes nothing at runtime and keeps the rule
        // satisfied honestly rather than by suppressing it. The effect must not
        // re-run: it owns an animation frame and the gems' lifetimes, and
        // restarting it would reset every twinkle mid-flare.
    }, [videoRef, canvasRef, matchRef]);

    if (!CAPTURE_LIVE_MESH.enabled) return null;

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            className="rz-live-mesh"
            style={{
                /*
                 * Mirrored with the preview, never independently. The landmarks
                 * are measured on the UNMIRRORED stream, and the video is
                 * flipped by a CSS transform — so the overlay has to take the
                 * same transform or it lands on the wrong side of the face.
                 * `CAPTURE_MIRROR` is the one switch that decides this for
                 * every self-view in the app.
                 */
                transform: CAPTURE_MIRROR.enabled ? 'scaleX(-1)' : 'none',
                /*
                 * ⚠️ HIDDEN, NOT UNMOUNTED — see the `hidden` prop.
                 *
                 * `opacity` keeps the draw loop, the landmark detection and
                 * `onBounds` all running, which is required: the caller places
                 * the glass oval and drives the camera zoom from this
                 * component's reports. Unmounting to hide the tracery would
                 * silently hand both back to their coarser fallbacks and then
                 * jump when it returned.
                 */
                opacity: hidden ? 0 : 1,
                transition: 'opacity 200ms ease-out',
            }}
        />
    );
}

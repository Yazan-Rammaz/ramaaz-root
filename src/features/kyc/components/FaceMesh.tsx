'use client';

import { useEffect, useRef } from 'react';

import { CAPTURE_LIVE_MESH, CAPTURE_MIRROR } from '@/features/kyc/config/capture';
import { useFaceLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';

/**
 * The face mesh over the live camera, lit like the rest of this flow.
 *
 * ── What it draws ───────────────────────────────────────────────────────────
 * A coarse triangulation of the whole face, drawn STEADY — plus a handful of
 * gems that sit on its vertices, flare, fade, and come back somewhere else. The
 * geometry holds still; only the gems move, and they move by appearing and
 * disappearing rather than by travelling.
 *
 * The triangles are MediaPipe's tessellation collapsed onto a grid (`coarsen`),
 * because its native 478 points make triangles a few pixels across — a texture,
 * not geometry. `cellSize` is how big they are.
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
 * between, the mesh EASES toward the newest landmarks, so it moves at the
 * display's rate while the network runs at a fraction of it. Running detection
 * per frame would not even look better — the model's own output jitters, and
 * the same filter that fills the gaps is what takes that out.
 *
 * ── Two things that were tried and are wrong ────────────────────────────────
 * Both are recorded because each looked obviously right before it was drawn.
 *
 * CHAINING the tessellation into long paths, so a dashed stroke could run along
 * them. A greedy walk through a triangulation wanders, and thinning the runs by
 * dropping vertices cut across the triangles they came from — so the "mesh"
 * became a few hundred zigzag threads over somebody's face. The triangles ARE
 * the geometry; making them bigger has to preserve them, which is what
 * clustering does and edge-dropping does not.
 *
 * DASHES as the moving light. A dash travelling a path is the line being drawn
 * in pieces, so it always reads as thread, never as a spark. A gem appears,
 * shines, and is gone somewhere else; only discrete points with their own
 * lifetimes do that.
 */

/** The edge list's type, derived from a value — `Connection` is not exported. */
type Edges = typeof import('@mediapipe/tasks-vision').FaceLandmarker.FACE_LANDMARKS_TESSELATION;

/** One gem: which vertex it sits on, when it appeared, and how long it lives. */
interface Gem {
    at: number;
    born: number;
    life: number;
}

/** A coarse mesh: edge endpoints in pairs, and the vertices that survived. */
interface Coarse {
    edges: Int32Array;
    vertices: Int32Array;
}

/**
 * Collapse the tessellation onto a grid, giving larger triangles.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * MediaPipe's mesh is 478 points over a single face, so its triangles are a few
 * pixels across. Drawn over somebody filling the frame, that is not geometry —
 * it is a texture, and the lines overlap into a grey haze.
 *
 * Dropping edges does not fix it. The triangles stay exactly as small; they
 * just acquire holes, which looks like damage rather than simplification.
 *
 * ── Vertex clustering ───────────────────────────────────────────────────────
 * Divide the face into cells `cell` wide, elect ONE representative landmark per
 * cell, then redraw every original edge between its endpoints' representatives.
 * Edges whose ends fall in the same cell collapse to nothing and are dropped;
 * edges that now coincide fold together. What is left is a real triangulation
 * of the same face at whatever resolution the cell size asks for.
 *
 * ⚠️ Normalised by the FACE'S BOUNDING BOX, not by the frame. Against the frame
 * the triangles would get finer as somebody leaned in, which is backwards — the
 * geometry should belong to the face, not to how much of the picture it happens
 * to occupy.
 *
 * Called ONCE, on the first detection. Re-running it per frame would reshuffle
 * the whole wireframe every time a landmark crossed a cell boundary.
 */
function coarsen(points: Float32Array, edges: Edges, cell: number): Coarse {
    const n = points.length / 2;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = points[i * 2];
        const y = points[i * 2 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const fw = Math.max(1e-4, maxX - minX);
    const fh = Math.max(1e-4, maxY - minY);

    const rep = new Int32Array(n);
    const cells = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        const gx = Math.floor((points[i * 2] - minX) / fw / cell);
        const gy = Math.floor((points[i * 2 + 1] - minY) / fh / cell);
        // One integer key rather than a string: this runs over 478 points and
        // string keys here were measurable next to nothing else in the loop.
        const key = gx * 4096 + gy;
        const found = cells.get(key);
        if (found === undefined) {
            cells.set(key, i);
            rep[i] = i;
        } else {
            rep[i] = found;
        }
    }

    const seen = new Set<number>();
    const out: number[] = [];
    for (const { start, end } of edges) {
        const a = rep[start];
        const b = rep[end];
        if (a === b) continue; // Both ends in one cell — the edge is gone.
        const key = a < b ? a * 512 + b : b * 512 + a;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a, b);
    }

    return {
        edges: Int32Array.from(out),
        // The gems sit on these, so they land on the intersections of the mesh
        // that is actually drawn rather than on discarded landmarks between
        // them — which read as specks floating in the middle of a triangle.
        vertices: Int32Array.from(new Set(out)),
    };
}

export function FaceMesh({
    videoRef,
    onBounds,
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
    onBounds?: (b: { cx: number; cy: number; rx: number; ry: number }) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
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

    /** The tessellation, fetched once from the module the hook already loaded. */
    const edgesRef = useRef<Edges | null>(null);
    /** The clustered mesh actually drawn. Built once; see `coarsen`. */
    const coarseRef = useRef<Coarse | null>(null);
    const gemsRef = useRef<Gem[]>([]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const { FaceLandmarker: L } = await import('@mediapipe/tasks-vision');
                if (!cancelled) edgesRef.current = L.FACE_LANDMARKS_TESSELATION;
            } catch {
                // Nothing to draw without the edge list. The overlay stays
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
            cellSize,
            lineWidth,
            baseAlpha,
            dotCount,
            dotMinLifeMs,
            dotMaxLifeMs,
            dotRadius,
            maxDpr,
        } = CAPTURE_LIVE_MESH;
        const detectEvery = 1000 / detectFps;

        const draw = (now: number) => {
            frame = requestAnimationFrame(draw);

            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (!canvas || !video?.videoWidth) return;

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
             * ratio. Same arithmetic as `drawProbe` in LivenessCamera.
             */
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const frameAspect = cssW / cssH;
            const streamAspect = vw / vh;
            const sw = streamAspect > frameAspect ? vh * frameAspect : vw;
            const sh = streamAspect > frameAspect ? vh : vw / frameAspect;
            const sx = (vw - sw) / 2;
            const sy = (vh - sh) / 2;

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
                            // The coarse mesh is built from these first real
                            // landmarks and then kept — see `coarsen`.
                            coarseRef.current = coarsen(
                                target,
                                edgesRef.current ?? [],
                                cellSize,
                            );
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
            const coarse = coarseRef.current;
            if (!target || !cur || !coarse) return;

            // ── Ease toward the latest landmarks ────────────────────────────
            for (let i = 0; i < cur.length; i++) {
                cur[i] += (target[i] - cur[i]) * smoothing;
            }

            /*
             * ── The wireframe ───────────────────────────────────────────────
             *
             * Each edge drawn where it is, with its own `moveTo`. ~2600
             * segments, ONE path, ONE stroke — the cost of a triangulation is
             * in the stroke calls, not the segments.
             *
             * `miter` joins and `butt` caps: `round` is what made this read as
             * soft tubing instead of geometry, because it takes the corner off
             * every triangle — and the corners are what it is made of.
             */
            ctx.beginPath();
            const { edges: pairs, vertices: nodes } = coarse;
            for (let e = 0; e < pairs.length; e += 2) {
                const a = pairs[e] * 2;
                const b = pairs[e + 1] * 2;
                ctx.moveTo(cur[a] * w, cur[a + 1] * h);
                ctx.lineTo(cur[b] * w, cur[b + 1] * h);
            }
            ctx.lineJoin = 'miter';
            ctx.miterLimit = 6;
            ctx.lineCap = 'butt';
            ctx.lineWidth = Math.max(1, lineWidth * dpr);
            ctx.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
            ctx.stroke();

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

                const px = cur[gem.at * 2] * w;
                const py = cur[gem.at * 2 + 1] * h;

                // The halo. Two draws rather than `shadowBlur`, which is a
                // per-draw blur pass and the most expensive thing that could be
                // asked for on this screen.
                const halo = ctx.createRadialGradient(px, py, 0, px, py, core * 4);
                halo.addColorStop(0, `rgba(210, 235, 255, ${0.5 * flare})`);
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
                ctx.fillStyle = `rgba(255, 255, 255, ${0.25 + 0.75 * flare})`;
                ctx.fill();
            }
        };

        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
    }, [videoRef]);

    if (!CAPTURE_LIVE_MESH.enabled) return null;

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            className="rz-live-mesh"
            /*
             * Mirrored with the preview, never independently. The landmarks are
             * measured on the UNMIRRORED stream, and the video is flipped by a
             * CSS transform — so the overlay has to take the same transform or
             * it lands on the wrong side of the face. `CAPTURE_MIRROR` is the
             * one switch that decides this for every self-view in the app.
             */
            style={{ transform: CAPTURE_MIRROR.enabled ? 'scaleX(-1)' : 'none' }}
        />
    );
}

'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useFaceLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';

/**
 * A live face mesh drawn over the liveness camera, while the user is lining up.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * MediaPipe's face mesh, tracked frame by frame and drawn as a thin sheen that
 * follows the face — it tilts, turns and scales with the user because it IS the
 * user's geometry, not an animation played at them.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 * It takes no part in the check. Nothing here is measured, sent, or consulted:
 * AWS reads frames from the MediaStream, and this only paints on a canvas above
 * the video. If the model fails to load, nothing renders and the check runs
 * exactly as before. That is why it is a separate component rather than
 * something woven into LivenessCamera — it must be removable without touching
 * the check, and removing it is deleting one line there.
 *
 * ⚠️ It is not free. This runs a second ML model while AWS is already running
 * Blazeface and encoding video to a WebSocket, and on a slow phone that
 * contention can cost the liveness stream frames — which is what lowers a
 * confidence score. The budget below and the shutdown at capture are both about
 * that. Measure a real score on the bench with this on and off before trusting
 * it in the sign-in.
 */

/**
 * Sample rate. The mesh is decoration, so it gets the leftovers.
 *
 * 15/s is well under the camera's 30 and looks smooth at this size, while
 * halving how often we compete with AWS's own inference. The DRAW runs on every
 * animation frame — only detection is throttled — so it never looks stepped.
 */
const DETECT_INTERVAL_MS = 1000 / 15;

/**
 * Minimum spacing between mesh vertices, as a fraction of face width.
 *
 * This is the knob that decides how busy the mesh looks. MediaPipe's own
 * tesselation is 2,556 edges over a face a couple of hundred pixels wide, which
 * at this size is a grey veil rather than a wireframe — the face stops being
 * readable, which is the one thing it must stay. Thinning the VERTICES and
 * rebuilding the edges from them keeps a real triangulation while cutting it to
 * roughly a tenth of the lines.
 *
 * Larger = sparser. Measured over a face-sized point cloud: 0.085 gives 109
 * nodes and 304 edges, 0.125 gives 54 and 126 — half the nodes, 40% of the
 * lines. The mesh is a hint that the face is being read, not a readout.
 */
const MIN_VERTEX_SPACING = 0.125;

/** Pale cyan, per the reference: lines translucent, nodes brighter. */
const LINE_COLOR = 'rgba(126, 205, 232, 0.3)';
const DOT_COLOR = 'rgba(222, 244, 252, 0.55)';

/** Neighbours each node is wired to. 4 lands at ~2.3 edges per node. */
const NEIGHBOURS = 4;

/** Longest edge kept, as a multiple of the vertex spacing. */
const MAX_EDGE = 2.6;

/**
 * The nose, as a set of landmark indices.
 *
 * The eyes and lips come from MediaPipe's own contour sets, which is why they
 * are not listed here. There is no equivalent set for the nose, so these are
 * the bridge (168, 6, 197, 195), the tip (4, 1) and the wings (98, 327) —
 * enough to bound the region without inventing a shape.
 */
const NOSE_INDICES = [168, 6, 197, 195, 4, 1, 98, 327];

/** How far each keep-clear zone is grown past the landmarks that define it. */
const ZONE_PAD = 1.2;

type Connection = { start: number; end: number };
type Zone = { cx: number; cy: number; r: number };

/**
 * Circle enclosing a set of landmarks, grown a little.
 *
 * Used to fence off the features the mesh must not cover. A circle rather than
 * the true outline on purpose: the eye moves inside its own contour as it
 * blinks and looks around, and a fence that tracked the outline exactly would
 * let lines creep back over the eye every time it narrowed.
 */
function zoneAround(landmarks: { x: number; y: number }[], indices: number[]): Zone | null {
    const pts = indices.map((i) => landmarks[i]).filter(Boolean);
    if (!pts.length) return null;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
        cx += p.x;
        cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    return { cx, cy, r: r * ZONE_PAD };
}

/** Does the segment a→b pass through the zone? Point-to-segment distance. */
function crosses(ax: number, ay: number, bx: number, by: number, z: Zone): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((z.cx - ax) * dx + (z.cy - ay) * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    return (px - z.cx) ** 2 + (py - z.cy) ** 2 < z.r * z.r;
}

/**
 * Thin the landmarks to a well-spaced subset, then wire each to its nearest
 * neighbours.
 *
 * ── Why not reuse MediaPipe's topology ──────────────────────────────────────
 * Two ways were tried first and both fail. Keeping every Nth tesselation edge
 * leaves a torn web: the survivors do not share endpoints, nothing closes into
 * triangles, and it reads as scribble. Thinning the vertices and re-pointing
 * every original edge at the nearest survivor keeps real adjacency, but the
 * long-range edges it produces came out at nearly ten per node — a denser mess
 * than the thing it was meant to thin.
 *
 * Nearest-neighbour wiring is purely geometric, so the density is predictable
 * and measurable: over a face-sized point cloud, 5 neighbours gives ~2.8 edges
 * per node and 4 gives ~2.3 — around what a planar triangulation has. That is
 * the difference between a wireframe and a veil.
 *
 * Computed ONCE, from the first face seen. Landmark semantics are fixed by the
 * model, so the answer holds for the session however the head moves — a
 * per-session cost, not a per-frame one.
 */
function buildSparseMesh(
    landmarks: { x: number; y: number }[],
    /** Eyes, nose and mouth — nothing is drawn on or across these. */
    zones: Zone[],
): {
    vertices: number[];
    edges: Connection[];
} {
    // Spacing is relative to the face's own width, so the mesh has the same
    // density whether the user is close to the lens or far from it.
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of landmarks) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
    }
    const minDist = (maxX - minX) * MIN_VERTEX_SPACING;
    const minDistSq = minDist * minDist;

    // Greedy furthest-first thinning: walk the landmarks and keep one only if
    // nothing already kept is within `minDist`. Simple, deterministic, and it
    // gives the even spread the dense original does not have.
    const vertices: number[] = [];
    for (let i = 0; i < landmarks.length; i++) {
        const p = landmarks[i];
        // Nothing sits on an eye, the nose or the mouth. Those are the features
        // a person reads a face by, and the ones an examiner needs to see.
        if (zones.some((z) => (p.x - z.cx) ** 2 + (p.y - z.cy) ** 2 < z.r * z.r)) continue;
        let ok = true;
        for (const v of vertices) {
            const q = landmarks[v];
            const dx = p.x - q.x;
            const dy = p.y - q.y;
            if (dx * dx + dy * dy < minDistSq) {
                ok = false;
                break;
            }
        }
        if (ok) vertices.push(i);
    }

    // Wire each node to its nearest neighbours. Deduped on the ordered pair, so
    // a–b and b–a are one edge; the length cap drops the occasional reach
    // across a gap that would otherwise cut over the face.
    const maxDistSq = (minDist * MAX_EDGE) ** 2;
    const seen = new Set<string>();
    const edges: Connection[] = [];
    for (const a of vertices) {
        const p = landmarks[a];
        const near = vertices
            .filter((b) => b !== a)
            .map((b) => ({
                b,
                d: (p.x - landmarks[b].x) ** 2 + (p.y - landmarks[b].y) ** 2,
            }))
            .sort((u, v) => u.d - v.d)
            .slice(0, NEIGHBOURS);
        for (const { b, d } of near) {
            if (d > maxDistSq) continue;
            // Keeping vertices out of a zone is not enough — two nodes either
            // side of an eye are near neighbours, and the edge between them
            // would run straight across it.
            const q = landmarks[b];
            if (zones.some((z) => crosses(p.x, p.y, q.x, q.y, z))) continue;
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ start: a, end: b });
        }
    }

    return { vertices, edges };
}

export function FaceMeshOverlay({
    containerRef,
}: {
    /** The box the mesh is drawn into — `LivenessCamera`'s wrapper. */
    containerRef: RefObject<HTMLDivElement | null>;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { isReady, detect } = useFaceLandmarker();

    useEffect(() => {
        if (!isReady) return;

        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let raf = 0;
        let stopped = false;
        /** The thinned mesh — built on first detection, then reused. */
        let mesh: { vertices: number[]; edges: Connection[] } | null = null;
        let lastDetect = 0;
        /** Last landmarks seen, so the draw can run faster than the detector. */
        let points: { x: number; y: number }[] | null = null;
        /** Eased 0..1, so the mesh fades rather than blinking on and off. */
        let presence = 0;
        /** Latched once AWS starts recording. See the block below. */
        let captured = false;
        /** Landmark indices of the features to keep clear. */
        let zoneIndices: number[][] | null = null;

        void (async () => {
            const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
            if (stopped) return;
            // Taken from MediaPipe's own contour sets rather than written out as
            // index literals, so the eyes and mouth cannot drift from whatever
            // the installed model actually calls them.
            const ids = (cs: Connection[]) => [
                ...new Set(cs.flatMap((c) => [c.start, c.end])),
            ];
            zoneIndices = [
                ids(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),
                ids(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE),
                ids(FaceLandmarker.FACE_LANDMARKS_LIPS),
                NOSE_INDICES,
            ];
        })();

        const frame = (now: number) => {
            if (stopped) return;
            raf = requestAnimationFrame(frame);

            // AWS owns these, so they are found rather than held: their state
            // machine creates and destroys them, not ours.
            const video = container.querySelector('video');
            const anchor = container.querySelector<HTMLElement>(
                '.amplify-liveness-video-anchor',
            );
            if (!video || !anchor || !zoneIndices) return;

            const box = container.getBoundingClientRect();
            const vid = anchor.getBoundingClientRect();
            if (!box.width || !vid.width) return;

            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.round(box.width * dpr);
            const h = Math.round(box.height * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            // ── Off once the recording starts ──────────────────────────────
            //
            // The mesh is an aid for LINING UP. From the countdown onward the
            // user has nothing left to adjust, AWS is grabbing the frames it
            // will actually judge, and anything drawn over the face is in the
            // way of looking at it.
            //
            // Latched, never unlatched: this is a one-way trip through the
            // check, and a mesh that reappeared mid-measurement would be worse
            // than one that never left.
            //
            // It also stops a second ML model competing for the phone exactly
            // when dropped frames would cost the most — the measurement itself.
            if (!captured) {
                const countdown = container.querySelector(
                    '.amplify-liveness-countdown-container',
                );
                const freshness = container.querySelector<HTMLCanvasElement>(
                    '.amplify-liveness-freshness-canvas',
                );
                if (countdown || (freshness?.getBoundingClientRect().width ?? 0) > 0) {
                    captured = true;
                }
            }

            if (!captured && now - lastDetect >= DETECT_INTERVAL_MS) {
                lastDetect = now;
                const result = detect(video);
                const landmarks = result?.faceLandmarks?.[0];
                if (landmarks?.length) {
                    // Thin the topology once, from the first face seen. The
                    // landmark layout is fixed by the model, so this answer
                    // holds for the session however the head moves.
                    mesh ??= buildSparseMesh(
                        landmarks,
                        zoneIndices
                            .map((ids) => zoneAround(landmarks, ids))
                            .filter((z): z is Zone => z !== null),
                    );

                    // Landmarks are normalised to the VIDEO FRAME. Two things
                    // turn them into canvas coordinates:
                    //
                    //  1. the video box is the anchor, which is wider than the
                    //     frame and centred — so it starts at a negative offset
                    //     and the sides are cropped. Offsetting by the anchor's
                    //     rect handles that without any crop maths.
                    //  2. `.amplify-liveness-video` is `transform: scaleX(-1)`,
                    //     a mirror for the user's benefit. The landmarks are NOT
                    //     mirrored, so x is flipped here, or the mesh lands on
                    //     the wrong side of the face.
                    const ox = (vid.left - box.left) * dpr;
                    const oy = (vid.top - box.top) * dpr;
                    const sw = vid.width * dpr;
                    const sh = vid.height * dpr;
                    points = landmarks.map((p) => ({
                        x: ox + (1 - p.x) * sw,
                        y: oy + p.y * sh,
                    }));
                } else {
                    points = null;
                }
            }

            // Ease towards the target so a momentary miss does not flicker, and
            // so the mesh dissolves at capture instead of vanishing.
            presence += ((points && !captured ? 1 : 0) - presence) * 0.12;

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (!points || !mesh || presence < 0.02) return;

            ctx.globalAlpha = presence;

            // Every edge in ONE path and ONE stroke. Stroking them individually
            // is hundreds of draw calls a frame, and this is sharing a phone
            // with the check.
            ctx.strokeStyle = LINE_COLOR;
            ctx.lineWidth = Math.max(1, 0.75 * dpr);
            ctx.lineJoin = 'round';
            ctx.beginPath();
            for (const c of mesh.edges) {
                const a = points[c.start];
                const b = points[c.end];
                if (!a || !b) continue;
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
            }
            ctx.stroke();

            // The nodes. Also one path — `moveTo` before each arc keeps them
            // from being joined into a single stroked outline.
            const r = Math.max(1.2, 1.7 * dpr);
            ctx.fillStyle = DOT_COLOR;
            ctx.beginPath();
            for (const v of mesh.vertices) {
                const p = points[v];
                if (!p) continue;
                ctx.moveTo(p.x + r, p.y);
                ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            }
            ctx.fill();

            ctx.globalAlpha = 1;
        };

        raf = requestAnimationFrame(frame);
        return () => {
            stopped = true;
            cancelAnimationFrame(raf);
        };
    }, [isReady, detect, containerRef]);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            /* Ordinary compositing, deliberately. The oval ring uses `screen`
               so it reads as light; this must read as a mark ON the face, and
               screen would blow a skin-toned line out toward white — the exact
               washed-out look this is meant to avoid. */
            className="pointer-events-none absolute inset-0 z-1 h-full w-full"
        />
    );
}

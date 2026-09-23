'use client';

import { useEffect, useRef } from 'react';

import { CAPTURE_LIVE_MESH, CAPTURE_MIRROR } from '@/features/kyc/config/capture';
import { useFaceLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';

/**
 * The Face Mesh over the live camera, lit like the rest of this flow.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * MediaPipe's 478-point mesh, drawn as a hairline tracery with a shine sweeping
 * across it and a handful of landmarks twinkling — the same language as the AI
 * mark's stars and the Face ID glyph, rather than the flat wireframe this used
 * to be.
 *
 * ── ⚠️ IT CANNOT AFFECT THE CHECK, and that is structural ───────────────────
 * AWS streams the MediaStream TRACK to Rekognition and runs its face-fit test
 * against the stream's own geometry. This is a sibling canvas painting over the
 * top; neither reads it. The capture is `drawImage` on AWS's video element,
 * which reads the decoded frame and ignores everything painted over it. Same
 * separation as the live glass and the retouched preview — see the header of
 * `useLivePreview`. Any change that lets these pixels feed back into the check
 * is a security regression, not a visual one.
 *
 * ── The two clocks ──────────────────────────────────────────────────────────
 * The model runs at `detectFps`; the canvas draws on every animation frame. In
 * between, the mesh EASES toward the newest landmarks, so it moves at the
 * display's rate while the network runs at a fraction of it. Running detection
 * per frame would not even look better — the model's own output jitters, and
 * the same filter that fills the gaps is what takes that out.
 *
 * ── Why the shine is one gradient and not 1300 ──────────────────────────────
 * The mesh is stroked once as a single path, then a moving gradient is filled
 * over it with `source-atop`, which paints ONLY where the path already is. One
 * fill lights every segment it crosses. Per-segment gradients would be the
 * obvious approach and would cost a thousand times more for the same picture —
 * it is the canvas equivalent of the `mask` + gradient trick `<Icon mask>` uses
 * to shine the star glyphs.
 */

/**
 * The tessellation's own type, derived from the value.
 *
 * `Connection` is declared inside `@mediapipe/tasks-vision` but not exported,
 * so it cannot be imported by name — `typeof` on the static reaches it without
 * re-declaring a shape that would then be free to drift from theirs.
 */
type Tessellation =
    typeof import('@mediapipe/tasks-vision').FaceLandmarker.FACE_LANDMARKS_TESSELATION;

/**
 * Which landmarks twinkle: brow, chin, both eye corners, both mouth corners,
 * nose tip, both cheekbones.
 *
 * Chosen to be spread across the face rather than clustered, and to sit on
 * FEATURES — a sparkle on a cheek reads as dirt on the lens; one on the corner
 * of an eye reads as a highlight.
 */
const SPARKLE_IDS = [10, 152, 33, 263, 61, 291, 1, 234, 454];

export function FaceMesh({
    videoRef,
}: {
    /**
     * AWS's own <video>. Owned by `LivenessCamera`'s sampling loop, which is
     * the only thing that can find it — the element is created inside the
     * detector's tree and appears asynchronously.
     */
    videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { detect, isReady } = useFaceLandmarker();

    /** Kept in refs: the draw loop owns them and nothing renders from them. */
    const readyRef = useRef(isReady);
    readyRef.current = isReady;
    const detectRef = useRef(detect);
    detectRef.current = detect;

    /**
     * Where the mesh IS and where it is HEADED, as flat x,y pairs in the
     * element's own 0..1 space.
     *
     * Flat `Float32Array`s rather than arrays of points: this is read and
     * written 60 times a second across ~950 numbers, and the allocation
     * churn of rebuilding point objects per frame is the kind of cost that
     * only shows up as jank on the device that can least afford it.
     */
    const targetRef = useRef<Float32Array | null>(null);
    const currentRef = useRef<Float32Array | null>(null);
    const seenRef = useRef(false);
    const lastDetectRef = useRef(0);

    /** The tessellation, fetched once from the module the hook already loaded. */
    const edgesRef = useRef<Tessellation | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const vision = await import('@mediapipe/tasks-vision');
                if (!cancelled) {
                    edgesRef.current = vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
                }
            } catch {
                // Nothing to draw without the connection list. The overlay stays
                // empty, which is exactly what it does before the model loads —
                // no error state worth showing for a decoration.
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
            decimate,
            lineWidth,
            baseAlpha,
            shineMs,
            sparkles,
            maxDpr,
        } = CAPTURE_LIVE_MESH;
        const detectEvery = 1000 / detectFps;

        const draw = (now: number) => {
            frame = requestAnimationFrame(draw);

            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (!canvas || !video?.videoWidth) return;

            /*
             * Size to the element's CSS box, capped.
             *
             * Read every frame because the frame is responsive — the XD-pixel
             * scale means a window resize changes this box's size in real
             * pixels without React re-rendering anything here.
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
             * Landmarks are normalised over the VIDEO, and the frame shows a
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
            const edges = edgesRef.current;
            if (!target || !cur || !edges) return;

            // ── Ease toward the latest landmarks ────────────────────────────
            for (let i = 0; i < cur.length; i++) {
                cur[i] += (target[i] - cur[i]) * smoothing;
            }

            // ── The tracery ─────────────────────────────────────────────────
            ctx.beginPath();
            for (let e = 0; e < edges.length; e += decimate) {
                const a = edges[e].start * 2;
                const b = edges[e].end * 2;
                ctx.moveTo(cur[a] * w, cur[a + 1] * h);
                ctx.lineTo(cur[b] * w, cur[b + 1] * h);
            }
            ctx.lineWidth = Math.max(1, lineWidth * dpr);
            ctx.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
            ctx.lineJoin = 'round';
            ctx.stroke();

            // ── The twinkles ────────────────────────────────────────────────
            for (let s = 0; s < sparkles; s++) {
                const id = SPARKLE_IDS[s % SPARKLE_IDS.length];
                const px = cur[id * 2] * w;
                const py = cur[id * 2 + 1] * h;
                /*
                 * Periods that share no common factor, each offset by its own
                 * phase — so no two ever peak together. Three stars pulsing in
                 * step is a loading spinner; three drifting is alive. Same
                 * reasoning as `AiSparkle`'s three durations.
                 */
                const period = 1500 + s * 317;
                const t = ((now + s * 613) % period) / period;
                const pulse = Math.sin(t * Math.PI * 2) * 0.5 + 0.5;
                const r = (2.5 + pulse * 5) * dpr;

                const glow = ctx.createRadialGradient(px, py, 0, px, py, r * 2.4);
                glow.addColorStop(0, `rgba(255, 255, 255, ${0.5 + pulse * 0.5})`);
                glow.addColorStop(0.45, `rgba(150, 200, 255, ${0.25 * pulse})`);
                glow.addColorStop(1, 'rgba(120, 170, 255, 0)');
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(px, py, r * 2.4, 0, Math.PI * 2);
                ctx.fill();

                // The four-point star. Thin crossing strokes, which is what
                // separates a sparkle from a dot of light.
                ctx.beginPath();
                ctx.moveTo(px - r, py);
                ctx.lineTo(px + r, py);
                ctx.moveTo(px, py - r);
                ctx.lineTo(px, py + r);
                ctx.lineWidth = Math.max(1, 0.8 * dpr);
                ctx.strokeStyle = `rgba(255, 255, 255, ${0.35 + pulse * 0.55})`;
                ctx.stroke();
            }

            /*
             * ── The shine ───────────────────────────────────────────────────
             *
             * One gradient over everything already drawn. `source-atop` clips
             * it to the existing alpha, so it lights the mesh and the sparkles
             * and paints nothing on the face between them.
             *
             * It sweeps diagonally across the whole frame rather than across
             * the face's own box: a band that starts and stops at the
             * silhouette reads as a rectangle moving, which is the one thing
             * that would give away that this is a flat overlay.
             */
            const sweep = ((now % shineMs) / shineMs) * 2 - 0.5;
            const band = ctx.createLinearGradient(
                sweep * w,
                0,
                sweep * w + w * 0.55,
                h,
            );
            band.addColorStop(0, 'rgba(255, 255, 255, 0)');
            band.addColorStop(0.35, 'rgba(180, 215, 255, 0.55)');
            band.addColorStop(0.5, 'rgba(255, 255, 255, 0.95)');
            band.addColorStop(0.65, 'rgba(160, 190, 255, 0.5)');
            band.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = band;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'source-over';
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

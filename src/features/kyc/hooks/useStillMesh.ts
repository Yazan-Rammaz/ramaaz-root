'use client';

import { useEffect, useState } from 'react';

import { CAPTURE_LIVE_MESH } from '@/features/kyc/config/capture';
import { detectStill } from '@/features/kyc/hooks/useFaceLandmarker';
import {
    buildWeb,
    ringOrder,
    type Edges,
    type Web,
} from '@/features/kyc/services/faceMesh';

/**
 * The face in a PHOTOGRAPH, as a wireframe — found once and then kept.
 *
 * The live mesh re-detects 22 times a second because the face is moving. This
 * one runs the model exactly once: the verdict screen's picture is a frozen
 * frame, so the landmarks it yields are the landmarks forever. Everything after
 * that is drawing.
 *
 * ── Why the points are in the IMAGE's space, not the frame's ────────────────
 * The frame is responsive — XD-pixel scaling means its size in real pixels
 * changes with the window without React re-rendering anything. Landmarks stored
 * in the frame's coordinates would therefore be wrong after a resize, and would
 * have to be re-detected to fix it. Stored against the image they are true for
 * as long as the image is, and `VerdictMesh` maps them through `coverCrop` on
 * whatever box it finds itself in, per frame.
 *
 * ── Failure is a valid answer ───────────────────────────────────────────────
 * `ready` stays false when the model never downloaded, the still is missing, or
 * no face was found in it — all three are ordinary, and none of them is an
 * error worth showing anybody. The caller draws its fallback mark instead.
 */
export interface StillMesh {
    /**
     * The web spun onto the face — its own points, in the IMAGE's 0..1 space.
     *
     * The landmarks themselves are not kept: they were needed to find the
     * face's outline and centre, and the web is built from those two things
     * alone. Nothing downstream has any use for the other 470 points.
     */
    web: Web | null;
    /** The image's own pixel size — what `coverCrop` needs. */
    natural: { w: number; h: number } | null;
    /** True once both above are present and the web can be drawn. */
    ready: boolean;
    /**
     * True once the attempt is OVER — with a mesh or without one.
     *
     * ⚠️ The difference between "not yet" and "never" is what the fallback
     * mark hangs on. Drawn on `!ready` alone, the AI star flashed for the
     * second the model spent finding the face, and then the mesh replaced it —
     * two marks in a row for one state. The star is for a mesh that is NOT
     * coming; while one may still arrive, nothing is drawn in its place.
     * Bounded: `detectStill` gives up after six seconds.
     */
    settled: boolean;
}

const PENDING: StillMesh = { web: null, natural: null, ready: false, settled: false };
/** No mesh will come — no still, or the mesh switched off. */
const NONE: StillMesh = { web: null, natural: null, ready: false, settled: true };

export function useStillMesh(src: string | null): StillMesh {
    /*
     * The result carries the picture it was read from, and the hook hands it
     * back only while that is still the picture being asked about.
     *
     * ⚠️ Why the `src` field, rather than clearing the state when `src`
     * changes: clearing means a `setState` in the effect body, which cascades a
     * render — and worse, it would hand out the PREVIOUS face's wireframe for
     * the frame between the new source arriving and the model answering. A
     * mesh belongs to one photograph; tagging it is how that stays true.
     */
    const [found, setFound] = useState<(StillMesh & { src: string }) | null>(null);

    useEffect(() => {
        if (!src || !CAPTURE_LIVE_MESH.enabled) return;

        let cancelled = false;
        // Every way out below that is not a mesh is an answer too.
        const giveUp = () => {
            if (!cancelled) setFound({ src, ...NONE });
        };

        void (async () => {
            try {
                /*
                 * Decoded off-screen and never mounted. The frame already
                 * renders this exact data URL in an <img> of its own; a second
                 * element only exists so the model is handed a picture whose
                 * pixels are guaranteed decoded, rather than whatever the
                 * displayed one happens to have finished.
                 */
                const image = new Image();
                image.src = src;
                await image.decode();
                if (cancelled) return;

                const result = await detectStill(image);
                if (cancelled) return;

                const landmarks = result?.faceLandmarks?.[0];
                if (!landmarks?.length) return giveUp();

                const points = new Float32Array(landmarks.length * 2);
                for (let i = 0; i < landmarks.length; i++) {
                    points[i * 2] = landmarks[i].x;
                    points[i * 2 + 1] = landmarks[i].y;
                }

                /*
                 * The outline comes from the module the model already loaded,
                 * so this import is a cache hit rather than a download.
                 */
                const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
                if (cancelled) return;

                const web = buildWeb(
                    points,
                    ringOrder(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL as Edges),
                    CAPTURE_LIVE_MESH,
                );
                // No outline, no web. Same answer as no face: nothing is drawn
                // and the caller shows its fallback mark.
                if (!web) return giveUp();

                setFound({
                    src,
                    web,
                    natural: { w: image.naturalWidth, h: image.naturalHeight },
                    ready: true,
                    settled: true,
                });
            } catch {
                // A still that would not decode, a model that would not load.
                // The mesh never becomes ready — see the note above.
                giveUp();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [src]);

    if (!src || !CAPTURE_LIVE_MESH.enabled) return NONE;
    return found && found.src === src ? found : PENDING;
}

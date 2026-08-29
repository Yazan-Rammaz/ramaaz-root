'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { useCamera } from '@/features/kyc/hooks/useCamera';
import { useFaceGate } from '@/features/kyc/hooks/useFaceGate';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Live face capture.
 *
 * XD: frame 350 x 400, radius 30, #000000, at y=302 on the 1024 canvas, centred
 * on x. Corner brackets 18 x 18 in #FFEB00. "Identity Verification !" (bold)
 * and "Live Face Detection" (medium) stack 12px apart above it, both #1D1D1D.
 *
 * ── The capture is automatic, and gated ─────────────────────────────────────
 * There is no shutter button, by design. `useFaceGate` samples the video and
 * only lets a frame through once a single face is present, centred, facing the
 * camera, well lit, in focus and still — held continuously for over a second.
 *
 * That hold is the whole interaction: the brackets close in and the ring fills
 * while it runs, so the moment of capture is something the person watched
 * happen rather than something that happened to them. It is also why nothing
 * unusable is ever uploaded — see the note in `useFaceGate` about failed frames
 * spending attempts the challenge cannot spare.
 *
 * ── The four phases ─────────────────────────────────────────────────────────
 *
 *   scanning    live video, brackets hunting, yellow sweep
 *   verifying   the captured still is LOCKED in the frame and the camera is
 *               released; a green scan line runs while the backend decides
 *   passed      green frame, held while the caller moves the flow on
 *   failed      red frame for two seconds, then the camera reopens
 *
 * Locking the still is not decoration. Between capture and verdict the live
 * preview would keep showing a moving face, which reads as "still looking" at
 * the exact moment nothing further is being looked at — and it invites the
 * person to move away from the pose that was actually captured.
 *
 * ── Nothing is written inside the frame ─────────────────────────────────────
 * No guidance, no status, no error — not even the camera-blocked message. The
 * frame is what the person looks into, and text inside it competes with the
 * one thing they are meant to be doing. Every state is carried visually
 * instead: brackets hunting, sweep searching, scan line checking, border green
 * or red for the verdict.
 *
 * The gate still computes every reason ("too far", "not facing", …) because
 * that is how it decides when to fire. It simply no longer narrates them.
 *
 * ⚠️ The tradeoff is real and worth knowing: a denied camera permission now
 * shows as a black rectangle that never resolves, with nothing on screen
 * saying why. If that proves confusing in use, the place to put it is OUTSIDE
 * the frame, under the title block — not back inside it.
 */

/**
 * How long every gate check must hold continuously before the frame is taken.
 *
 * Longer than the hook's 1.2s default, and deliberately: it gives the person
 * time to settle into the frame rather than being photographed the instant they
 * arrive in it, which is what made the capture feel like it fired at them. The
 * cost is that a blink-and-shift resets the hold, so it must not go much beyond
 * this — past about five seconds a normal person cannot hold it at all.
 */
const CAPTURE_HOLD_MS = 4500;

/** How long the red frame holds before the camera reopens. */
const FAILURE_HOLD_MS = 2000;

type Phase = 'scanning' | 'verifying' | 'passed' | 'failed';

type Props = {
    /** Given a captured frame as a data URL. Returning rejects it for retry. */
    onCapture: (frame: string) => Promise<{ error?: string } | void>;
    /**
     * The SERVER has accepted this face — show the passed state.
     *
     * ⚠️ Do not remove this in favour of the resolved value of `onCapture`.
     * On the happy path `onCapture` ends in a Server Action that redirects,
     * and `redirect()` signals by THROWING: the promise never resolves
     * normally, so the line below it does not run. Relying on it left the
     * screen scanning forever after a successful check — a green light that
     * never came. The parent learns of success from its own stage prop, which
     * always arrives, and says so here.
     */
    verified?: boolean;
};

export function FaceScanScreen({ onCapture, verified = false }: Props) {
    const t = useTranslations('auth');
    const { videoRef, canvasRef, error: cameraError, startCamera, stopCamera, captureFrame } =
        useCamera({ facingMode: 'user' });

    const [phase, setPhase] = useState<Phase>('scanning');
    /** The locked frame. Non-null from capture until the camera reopens. */
    const [shot, setShot] = useState<string | null>(null);

    // Sampling stops the moment we leave 'scanning': nothing downstream reads
    // the gate again until it is reset, and a paused gate is one less thing
    // competing for the video element while it is being torn down.
    const gate = useFaceGate({
        videoRef,
        paused: phase !== 'scanning',
        stabilityMs: CAPTURE_HOLD_MS,
    });
    const { ready: gateReady, reset: resetGate } = gate;
    const sent = useRef(false);

    useEffect(() => {
        void startCamera();
        return () => stopCamera();
    }, [startCamera, stopCamera]);

    // The hold completed — take the frame and hand it up. Guarded by a ref so a
    // re-render between `ready` and the phase change cannot fire a second
    // upload.
    useEffect(() => {
        if (!gateReady || sent.current) return;
        sent.current = true;

        void (async () => {
            const frame = captureFrame();
            if (!frame) {
                // Nothing to lock and nothing to send. Treated as a failure
                // rather than a special case: the recovery is identical, and
                // the person does not care which side of the camera the fault
                // was on.
                setPhase('failed');
                return;
            }

            setShot(frame);
            setPhase('verifying');
            // Release the camera. The still is what is on screen now, so the
            // stream has no job until the failure path reopens it — and holding
            // a live camera through a network round trip keeps the recording
            // indicator lit for no reason.
            stopCamera();

            const result = await onCapture(frame);
            setPhase(result?.error ? 'failed' : 'passed');
        })();
    }, [captureFrame, gateReady, onCapture, stopCamera]);

    // Failure recovery: hold the red frame long enough to be read, then unlock
    // and start over from a clean gate.
    useEffect(() => {
        if (phase !== 'failed') return;
        const timer = setTimeout(() => {
            setShot(null);
            sent.current = false;
            resetGate();
            setPhase('scanning');
            void startCamera();
        }, FAILURE_HOLD_MS);
        return () => clearTimeout(timer);
    }, [phase, resetGate, startCamera]);

    // What the frame SHOWS, as opposed to what this component is internally
    // doing. The two differ in exactly one case, and it is the common one: the
    // request succeeded and the parent knows it, while `phase` is still
    // 'verifying' because the promise that would have said so never resolved.
    //
    // 'failed' outranks `verified` so a rejection can never be painted green,
    // however the two signals happened to interleave.
    const shown: Phase = phase === 'failed' ? 'failed' : verified ? 'passed' : phase;

    // Brackets pull inward once the gate is holding and stay in while the
    // verdict is outstanding, so the frame never loosens mid-check.
    const active = gate.pass || phase !== 'scanning';

    const borderColor =
        shown === 'passed' ? '#34C759' : shown === 'failed' ? '#FF3B30' : 'transparent';

    const bracketColor =
        shown === 'failed' ? '#FF3B30' : gateReady || shown === 'passed' ? '#34C759' : '#FFEB00';

    return (
        <main className="flex h-full flex-col items-center">
            {/* Title block. 12px gaps, both #1D1D1D, sitting directly above the
                frame — so the group is positioned from the frame's y=302. */}
            <div
                className="flex flex-col items-center"
                style={{ marginTop: rem(302 - 12 - 20 - 12 - 38) }}
            >
                <h1 className="fz-24 h-38 leading-none font-bold text-[#1D1D1D]">
                    {t('identityTitle')}
                </h1>

                <div className="flex items-center gap-6" style={{ marginTop: rem(12) }}>
                    <Icon name="kyc/face_detect" width={20} height={20} alt="" />
                    <span className="fz-14 leading-none font-medium text-[#1D1D1D]">
                        {t('liveFaceDetection')}
                    </span>
                </div>
            </div>

            {/* Camera frame — 350 x 400, radius 30, black. The border is always
                present and only changes colour, so the verdict never nudges the
                layout by two pixels. */}
            <div
                className="relative h-400 w-350 overflow-hidden rad-30 border-2 bg-black transition-colors duration-300 motion-reduce:transition-none"
                style={{ marginTop: rem(12), borderColor }}
            >
                <video
                    ref={videoRef}
                    playsInline
                    muted
                    // Mirrored so moving left moves the image left, which is the
                    // only way a self-view reads correctly. `captureFrame`
                    // returns the UNmirrored pixels regardless — see useCamera.
                    className="h-full w-full -scale-x-100 object-cover"
                />

                {/* The locked frame. Mirrored to match the preview it was taken
                    from: the pixels are unmirrored, so without this the image
                    would flip at the instant of capture and read as a different
                    photograph of a different person. */}
                {shot && (
                    // A data URL held in memory for seconds. next/image would only
                    // put a loader between the capture and pixels already decoded.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={shot}
                        alt=""
                        aria-hidden
                        className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
                    />
                )}

                {/*
                  The surface `captureFrame()` draws onto — and it MUST be in
                  the tree. `useCamera` only owns the ref; with no element
                  behind it, captureFrame returns null on its very first line.
                  That surfaces as "could not capture" AFTER a successful gate
                  hold, which reads like a camera fault and is nothing of the
                  kind.

                  Kept in the layout at 1px rather than `display:none`: a canvas
                  inside a hidden subtree can rasterise blank in some browsers,
                  which would trade a loud failure for a silent black frame.
                */}
                <canvas
                    ref={canvasRef}
                    aria-hidden
                    className="pointer-events-none absolute h-1 w-1 opacity-0"
                />

                {/* Corner brackets, 18 x 18. They pull inward and turn green as
                    the hold completes: the iOS Face ID tell that the device has
                    locked on, rather than a spinner that means nothing. */}
                {(
                    [
                        ['top-0 start-0', 'border-t-2 border-s-2', 'rounded-ts-8'],
                        ['top-0 end-0', 'border-t-2 border-e-2', 'rounded-te-8'],
                        ['bottom-0 start-0', 'border-b-2 border-s-2', 'rounded-bs-8'],
                        ['bottom-0 end-0', 'border-b-2 border-e-2', 'rounded-be-8'],
                    ] as const
                ).map(([pos, edges, round]) => (
                    <span
                        key={pos}
                        aria-hidden
                        className={cn(
                            'absolute h-18 w-18 transition-all duration-500 ease-out motion-reduce:transition-none',
                            pos,
                            edges,
                            round,
                        )}
                        style={{
                            borderColor: bracketColor,
                            margin: rem(active ? 34 : 22),
                            opacity: active ? 1 : 0.85,
                        }}
                    />
                ))}

                {/* Scanning sweep while searching. Stops the moment the gate
                    starts holding, so the animation always means "still
                    looking" and never competes with the hold. */}
                {!active && !cameraError && (
                    <span
                        aria-hidden
                        className="face-sweep pointer-events-none absolute inset-x-0 h-64 motion-reduce:hidden"
                    />
                )}

                {/* Verification scan line over the locked still. It stops and
                    disappears the moment a verdict lands — the border takes
                    over from there, and a line still sweeping under a green
                    frame would say the check was somehow still running. */}
                {shown === 'verifying' && (
                    <span
                        aria-hidden
                        className="face-scanline pointer-events-none absolute inset-x-0 top-0 h-72 motion-reduce:hidden"
                    />
                )}

                {/* Hold progress — a hairline that fills across the frame's
                    foot over the stability window. */}
                <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-3 bg-white/15"
                    style={{ opacity: gate.pass && phase === 'scanning' ? 1 : 0 }}
                >
                    <span
                        className="absolute inset-y-0 start-0 bg-[#34C759] transition-[width] duration-150 ease-linear motion-reduce:transition-none"
                        style={{ width: `${Math.round(gate.progress * 100)}%` }}
                    />
                </span>

                {/* No text inside the frame. Every state it could describe is
                    already carried by something visual: the brackets, the
                    sweep, the scan line, and the border colour. */}
            </div>
        </main>
    );
}

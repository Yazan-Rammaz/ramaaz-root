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
 * XD: frame 350 x 400, radius 30, #000000, centred on BOTH axes. Corner brackets
 * 18 x 18 in #FFEB00, 6 thick with an 8 radius on the elbow. "Identity
 * Verification !" (bold) and "Live Face Detection" (medium) stack 12px apart
 * above it, both #1D1D1D.
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
 * How long every gate check must hold continuously before the frame is taken —
 * the window the green hairline fills across.
 *
 * Long enough that the person settles into the frame rather than being
 * photographed the instant they arrive in it, short enough that a blink or a
 * small shift does not keep resetting the hold. Past about five seconds a
 * normal person cannot hold it at all.
 */
const CAPTURE_HOLD_MS = 2000;

/** How long the red frame holds before the camera reopens. */
const FAILURE_HOLD_MS = 2000;

/**
 * Radius on the elbow of each corner bracket, in XD pixels.
 *
 * With 6-wide arms this leaves an inner radius of 2, which is what keeps the
 * bend reading as a bend rather than a mitre. Raising it past the arm width
 * would round the inside faster than the outside and the corner starts to look
 * like a comma.
 */
const BRACKET_RADIUS = 8;

/**
 * The title block's height in XD pixels, and its distance from the frame.
 *
 * `HEADER_H` is arithmetic rather than a measurement, and can be: the heading is
 * `h-38` and the caption row is a 20 icon beside `leading-none` text, both fixed,
 * with a 12 gap between them. Neither grows if the text wraps in another locale
 * — it would overflow instead — so the number holds for en/ar/tr alike.
 *
 * It is used twice: once as the real gap above the frame, and once as dead space
 * mirrored below it, which is what lets `justify-center` centre the FRAME rather
 * than the frame-plus-header. See the note at the frame.
 */
const HEADER_H = 38 + 12 + 20;
const HEADER_GAP = 12;

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
        <main className="flex h-full flex-col items-center justify-center">
            {/* Title block. 12px gaps, both #1D1D1D, sitting directly above the
                frame. */}
            <div className="flex flex-col items-center">
                <h1 className="fz-24 h-38 leading-none font-bold text-[#1D1D1D]">
                    {t('identityTitle')}
                </h1>

                <div className="flex items-center gap-6" style={{ marginTop: rem(HEADER_GAP) }}>
                    <Icon name="kyc/face_detect" width={20} height={20} alt="" />
                    <span className="fz-14 leading-none font-medium text-[#1D1D1D]">
                        {t('liveFaceDetection')}
                    </span>
                </div>
            </div>

            {/* Camera frame — 350 x 400, radius 30, black. The border is always
                present and only changes colour, so the verdict never nudges the
                layout by two pixels.

                ── The FRAME is what is centred, not the group ─────────────────
                `justify-center` would centre the title block and the frame
                together, which puts the frame's middle below the page's by half
                the header — the frame reads as sitting low, because it is. The
                bottom margin is that header mirrored underneath: it makes the
                flex line symmetrical about the frame, so centring the line
                centres the frame. Nothing else moves — the header still sits its
                12 above, and the 12 inside it is untouched. */}
            <div
                className="relative h-400 w-350 overflow-hidden rad-30 border-2 bg-black transition-colors duration-300 motion-reduce:transition-none"
                style={{
                    marginTop: rem(HEADER_GAP),
                    marginBottom: rem(HEADER_H + HEADER_GAP),
                    borderColor,
                }}
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
                    locked on, rather than a spinner that means nothing.

                    The radius is the LOGICAL corner property rather than a
                    utility class, because there isn't one to use: this project's
                    radius utility is `rad-*`, which sets all four corners, and
                    Tailwind's per-corner logical classes (`rounded-ss-*` and
                    friends) don't read the XD spacing scale. Setting one corner
                    matters — it is the elbow where the two borders actually
                    meet, and rounding the other three tapers the open ends of
                    each arm to a point. Logical means it mirrors in RTL on its
                    own (AGENTS.md §9), so `start-start` follows `start-0`. */}
                {(
                    [
                        ['top-0 start-0', 'border-t-6 border-s-6', 'borderStartStartRadius'],
                        ['top-0 end-0', 'border-t-6 border-e-6', 'borderStartEndRadius'],
                        ['bottom-0 start-0', 'border-b-6 border-s-6', 'borderEndStartRadius'],
                        ['bottom-0 end-0', 'border-b-6 border-e-6', 'borderEndEndRadius'],
                    ] as const
                ).map(([pos, edges, corner]) => {
                    const style: React.CSSProperties = {
                        borderColor: bracketColor,
                        [corner]: rem(BRACKET_RADIUS),
                        margin: rem(active ? 34 : 22),
                        opacity: active ? 1 : 0.85,
                    };
                    return (
                        <span
                            key={pos}
                            aria-hidden
                            className={cn(
                                'absolute h-18 w-18 transition-all duration-500 ease-out motion-reduce:transition-none',
                                pos,
                                edges,
                            )}
                            style={style}
                        />
                    );
                })}

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

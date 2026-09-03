'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { useCamera } from '@/features/kyc/hooks/useCamera';
import { useFaceGate } from '@/features/kyc/hooks/useFaceGate';
import { useFaceLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';
import { restartSignInAction } from '@/features/auth/actions';

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
    const {
        videoRef,
        canvasRef,
        isActive,
        error: cameraError,
        startCamera,
        stopCamera,
        captureFrame,
    } = useCamera({ facingMode: 'user' });

    // The landmarker is a module-level singleton, so asking for it here costs
    // nothing beyond the hook — `useFaceGate` is already holding the same
    // instance. What this buys is the two signals the gate does not surface:
    // whether the model is usable yet, and whether it failed outright.
    const { isReady: modelReady, loadError: modelError } = useFaceLandmarker();

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

    /**
     * The camera opens only once the detector can actually use it.
     *
     * The model is ~3.4MB on the wire and the WASM runtime another ~3.1MB, so
     * on a phone this is seconds, not milliseconds. Opening the camera first
     * lights the recording indicator, spins up the sensor and decodes frames
     * that are thrown away — all while nothing is able to look at them. Worse,
     * it tells the user the check has started: they hold still, and the capture
     * they are waiting for cannot come yet.
     *
     * So: preparing dots on a black frame, then the camera. Nothing is on that
     * is not being used.
     */
    useEffect(() => {
        if (!modelReady) return;
        void startCamera();
        return () => stopCamera();
    }, [modelReady, startCamera, stopCamera]);

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

    /**
     * Nothing can be looked for yet — the camera has not opened, or the face
     * landmarker's model is still downloading (3.6MB, and on a cold phone
     * connection that is seconds, not milliseconds).
     *
     * Worth distinguishing, because the two states look identical and are not.
     * A screen that shows the hunting sweep while the model is still loading is
     * telling the user "hold still, I am looking at you" when nothing is
     * looking at all — so they hold still, nothing happens, and the only
     * conclusion available to them is that it is broken.
     *
     * It was also how a real outage stayed invisible: the model 404'd in
     * production for want of a file, `useFaceLandmarker` swallows that by
     * design, and the screen showed a working camera that never captured.
     * `model_loading` that never ends now reads as a stuck preparing state
     * rather than as a face the gate keeps rejecting.
     */
    const preparing =
        phase === 'scanning' && !modelError && (!modelReady || !isActive);

    /**
     * Setup failed outright — most often the model 404ing, which is exactly
     * what happened in production.
     *
     * This is the ONE message on the screen, and it sits OUTSIDE the frame, in
     * the dead space the centring already reserves below it. That placement is
     * the design's own instruction for this case: the frame carries no text, so
     * anything that must be said goes under it. Without this the failure is
     * invisible — `useFaceLandmarker` swallows the error by design — and the
     * person is left looking at a black rectangle with no way to know that
     * waiting will never help.
     */
    const setupFailed = Boolean(modelError) || Boolean(cameraError);

    // Brackets pull inward once the gate is holding and stay in while the
    // verdict is outstanding, so the frame never loosens mid-check.
    const active = gate.pass || phase !== 'scanning';

    // Green or red ONLY on a verdict. Null the rest of the time, and the ring
    // is not drawn at all — no permanent outline around the frame.
    const verdictColor =
        shown === 'passed' ? '#34C759' : shown === 'failed' ? '#FF3B30' : null;

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

            {/* Camera frame — 350 x 400, radius 30, black. NO border of its own:
                the frame is the picture, and a permanent ring around it is a
                rule the design does not have. The verdict ring is drawn as an
                overlay inside the frame instead (see below), which is what lets
                the border exist only when there is a verdict without the video
                jumping two pixels when one lands.

                ── The FRAME is what is centred, not the group ─────────────────
                `justify-center` would centre the title block and the frame
                together, which puts the frame's middle below the page's by half
                the header — the frame reads as sitting low, because it is. The
                bottom margin is that header mirrored underneath: it makes the
                flex line symmetrical about the frame, so centring the line
                centres the frame. Nothing else moves — the header still sits its
                12 above, and the 12 inside it is untouched. */}
            <div
                className="relative h-400 w-350 overflow-hidden rad-30 bg-black"
                style={{
                    marginTop: rem(HEADER_GAP),
                    marginBottom: rem(HEADER_H + HEADER_GAP),
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

                {/* The verdict ring. An OVERLAY, not a border on the frame:
                    a border would take its 2px out of the 350 x 400 box, so the
                    video would shift the moment a verdict arrived — and a
                    transparent border held in reserve to avoid that is just the
                    permanent outline this screen is not supposed to have. Drawn
                    over the picture, it costs the layout nothing and exists only
                    when there is something to say. */}
                {verdictColor && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 rad-30 border-2"
                        style={{ borderColor: verdictColor }}
                    />
                )}

                {/* Corner brackets, 18 x 18. They pull inward and turn green as
                    the hold completes: the iOS Face ID tell that the device has
                    locked on, rather than a spinner that means nothing.

                    Shared with the liveness frame — see CornerBrackets for why
                    the elbow radius is an inline logical property. */}
                <CornerBrackets
                    color={bracketColor}
                    inset={active ? 34 : 22}
                    opacity={active ? 1 : 0.85}
                />

                {/* Preparing — camera opening, or the landmarker model still on
                    the wire. Three pulsing dots, no words: the frame carries no
                    text by design, and this has to read at a glance as "not
                    started yet" rather than as a verdict. It is deliberately
                    unlike the sweep and the scan line, which both mean work is
                    happening TO you. */}
                {preparing && !cameraError && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 flex items-center justify-center gap-8"
                    >
                        {[0, 1, 2].map((i) => (
                            <span
                                key={i}
                                className="face-prep-dot h-8 w-8 rounded-full bg-white/70 motion-reduce:animate-none"
                                style={{ animationDelay: `${i * 160}ms` }}
                            />
                        ))}
                    </span>
                )}

                {/* Scanning sweep while searching. Held back until the gate can
                    actually see — a sweep during `preparing` would claim to be
                    hunting for a face before anything is able to look. Stops
                    the moment the gate starts holding, so it always means
                    "still looking" and never competes with the hold. */}
                {!active && !preparing && !cameraError && (
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
                    sweep, the scan line, and the verdict ring. */}
            </div>

            {/* Setup failure, UNDER the frame — the only words on this screen.
                Zero-height so it cannot move the frame: it draws into the dead
                space the centring already reserves below. Absent unless
                something is genuinely broken, so the quiet frame stays quiet.

                The way out is `startOver`, not a reload, and the difference is
                not pedantic. Reloading this route re-reads the same challenge
                cookie and lands in the same broken state; the access link is
                what actually starts a sign-in, and its token is deliberately
                never held anywhere the page could link back to. So the only
                honest instruction is the one the other steps already give:
                open the link again. */}
            {setupFailed && (
                <div className="relative h-0 w-350">
                    <div
                        className="absolute inset-x-0 flex flex-col items-center gap-12"
                        style={{ top: rem(16) }}
                    >
                        <p
                            role="alert"
                            className="fz-12 px-20 text-center leading-normal font-medium text-[#FF3B30]"
                        >
                            {cameraError ? t('faceCameraBlocked') : t('faceSetupFailed')}
                        </p>
                        <button
                            type="button"
                            className="fz-14 text-primary leading-none font-semibold underline"
                            onClick={() => void restartSignInAction()}
                        >
                            {t('startOver')}
                        </button>
                    </div>
                </div>
            )}
        </main>
    );
}

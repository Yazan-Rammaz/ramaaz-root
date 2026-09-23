'use client';

import { useCallback, useEffect, useState } from 'react';

import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { LivenessCamera } from '@/features/kyc/components/LivenessCamera';
import { LivenessVerdict } from '@/features/kyc/components/LivenessVerdict';
import { CAPTURE_MIRROR } from '@/features/kyc/config/capture';
import type { FaceCapture } from '@/features/kyc/services/faceCapture';

/**
 * The liveness bench — attack the AWS check, read the score, go again.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * Proving that a spoof is refused takes many attempts: a printed photo, a phone
 * screen at several brightnesses, a video replay, a mask, a face on a laptop.
 * Doing that through the real sign-in means a fresh access link every time,
 * which is enough friction that the testing does not happen.
 *
 * This runs the same Rekognition Face Liveness check with no sign-in around it,
 * and shows the two numbers that matter.
 *
 * ── It is also the photo bench ──────────────────────────────────────────────
 * The frame keeps the capture after the run instead of going black, and prints
 * its pixel size, so the photograph the flow actually files can be judged
 * without walking a sign-in. It is shown unprocessed, because that is how it is
 * stored.
 *
 * ── What it deliberately cannot do ──────────────────────────────────────────
 * It talks to `/api/kyc/liveness-lab/*`, which never reads a challenge, never
 * returns an image, never calls CompareFaces and never mints a stepToken. There
 * is no path from this screen to being signed in. The secret that unlocks it
 * stays server-side in the proxy — see app/api/kyc/[...path]/route.ts.
 *
 * ── How to read the result ──────────────────────────────────────────────────
 * A spoof usually comes back **SUCCEEDED with a low confidence**: the session
 * completed, and the verdict is "not live". So `SUCCEEDED` alone means nothing
 * — the number is the answer. This matters because the real Worker path gates
 * on Status and passes the confidence to NestJS to judge, which is exactly the
 * seam a spoof would slip through.
 *
 * Record the confidence for each attack. A live face should sit high; the gap
 * between that and your best spoof is the margin a threshold has to live in.
 */

type Session = { sessionId: string; region: string };
type Result = {
    status: string;
    confidence: number;
    hasReferenceImage: boolean;
    auditImages: number;
};

/**
 * `waiting` is the camera-is-gone-but-AWS-has-not-answered window — five to ten
 * seconds of upload and analysis. It exists as its own phase because the
 * detector must stay mounted through it (unmounting kills the run) while the
 * screen has already moved on to the checking state.
 *
 * `fetching` is the shorter tail after that: our own result call.
 */
type Phase =
    | 'idle'
    | 'starting'
    | 'streaming'
    | 'waiting'
    | 'fetching'
    | 'done'
    | 'error';

/** XD px -> the scaling rem this project measures in (AGENTS.md §1). */
const rem = (px: number) => `${px * 0.0625}rem`;

export function LivenessLab() {
    const [phase, setPhase] = useState<Phase>('idle');
    const [session, setSession] = useState<Session | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Every run this page has done, newest first — the actual output. */
    const [log, setLog] = useState<{ at: string; status: string; confidence: number }[]>([]);

    /** The still `LivenessCamera` kept, and what size it turned out to be. */
    const [shot, setShot] = useState<string | null>(null);
    /**
     * The same frame without the portrait blur.
     *
     * Kept only for the checking state, which lays glass over it: the display
     * frame already has the room defocused, so glass on top softens the
     * background twice and the face once — a pane that covers everything but
     * the person. See `plainSnapshot` on LivenessVerdict.
     *
     * Not what the bench JUDGES. The panel below still shows `shot`, because
     * the display frame is the photograph a person is given.
     */
    const [shotPlain, setShotPlain] = useState<string | null>(null);
    const [shotSize, setShotSize] = useState<{ w: number; h: number } | null>(null);

    /**
     * Follows `CAPTURE_MIRROR`, so the bench shows what ships.
     *
     * `drawImage` reads raw pixels, so the capture is never mirrored; this
     * flips it back to match the preview, exactly as the real screens do. A
     * face you have only ever seen mirrored looks subtly wrong otherwise — the
     * kind of wrong that gets blamed on capture quality.
     *
     * The toggle stays: comparing the two sides is occasionally what you want
     * when a face looks off and you are deciding whether it is the capture or
     * the asymmetry of the face itself.
     */
    // Typed explicitly: `CAPTURE_MIRROR` is `as const`, so the initial value
    // is the literal `true` and the state would be inferred as `true` — a
    // setter that can never be given `false`.
    const [mirror, setMirror] = useState<boolean>(CAPTURE_MIRROR.enabled);

    /**
     * Hold the checking state up for as long as you want to look at it.
     *
     * The real thing lasts as long as one result fetch — a second or two — and
     * on this page each run costs a real AWS check. Reviewing an animation you
     * get two seconds of, at a pound a look, is not reviewing it.
     *
     * Held, it is the SAME component with the same props the sign-in passes, so
     * what you approve here is what ships. The only difference is that nothing
     * ends it.
     *
     * It composes with the still from the last run: run once, then hold, and
     * you are looking at the glass over a real capture of your own face rather
     * than over black. With no run at all it still renders — which is worth
     * seeing too, because a failed frame-grab is exactly that case.
     *
     * ⚠️ NEVER WHILE STREAMING, and the button is disabled there. Held over a
     * live camera it looks exactly like the bug it is not: the glass sitting
     * where the preview should be, AWS's own "move a little closer" hint
     * legible through it, and no way to tell from the screen that a review
     * toggle is the cause. A tool for inspecting a state must not be able to
     * impersonate that state arriving early.
     */
    const [holdChecking, setHoldChecking] = useState(false);

    const start = useCallback(async () => {
        setPhase('starting');
        setResult(null);
        setError(null);
        setShot(null);
        setShotPlain(null);
        setShotSize(null);
        // Released on every run. A review toggle left on from ten minutes ago
        // must not be part of what the next run shows — and the run that
        // follows is the one whose timing you are trying to watch.
        setHoldChecking(false);
        try {
            const res = await fetch('/api/kyc/liveness-lab/session', { method: 'POST' });
            if (!res.ok) throw new Error(`session ${res.status}`);
            const data = (await res.json()) as Session;
            if (!data.sessionId) throw new Error('no session id');
            setSession(data);
            setPhase('streaming');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'could not start');
            setPhase('error');
        }
    }, []);

    // Start the first run automatically — the page has one purpose.
    useEffect(() => {
        const raf = requestAnimationFrame(() => void start());
        return () => cancelAnimationFrame(raf);
    }, [start]);

    const credentialProvider = useCallback(async () => {
        const res = await fetch('/api/kyc/liveness-lab/credentials');
        if (!res.ok) throw new Error(`credentials ${res.status}`);
        const c = (await res.json()) as {
            accessKeyId: string;
            secretAccessKey: string;
            sessionToken: string;
            expiration?: string;
        };
        return {
            accessKeyId: c.accessKeyId,
            secretAccessKey: c.secretAccessKey,
            sessionToken: c.sessionToken,
            expiration: c.expiration ? new Date(c.expiration) : undefined,
        };
    }, []);

    const sessionId = session?.sessionId ?? null;

    const onComplete = useCallback(
        async (capture: FaceCapture | null) => {
            // Kept before anything can fail: the point of this page is now the
            // photo as much as the score, and a result fetch that 500s should
            // not also lose the capture.
            //
            // `display`, because this page is judging the photograph a person
            // is shown. The look pipeline is dissected on /design/capture-lab,
            // which shows both and says which is which.
            setShot(capture?.display ?? null);
            setShotPlain(capture?.stored ?? null);
            if (!sessionId) return;
            setPhase('fetching');
            try {
                const res = await fetch(
                    `/api/kyc/liveness-lab/result?sessionId=${encodeURIComponent(sessionId)}`,
                );
                if (!res.ok) throw new Error(`result ${res.status}`);
                const data = (await res.json()) as Result;
                setResult(data);
                setLog((prev) =>
                    [
                        {
                            at: new Date().toLocaleTimeString(),
                            status: data.status,
                            confidence: data.confidence,
                        },
                        ...prev,
                    ].slice(0, 12),
                );
                setPhase('done');
            } catch (err) {
                setError(err instanceof Error ? err.message : 'could not fetch result');
                setPhase('error');
            }
        },
        [sessionId],
    );

    // A spoof typically scores low but still reports SUCCEEDED, so the verdict
    // shown is drawn from the NUMBER, not the status. 80 is a starting point,
    // not a recommendation — the right threshold comes from your own runs.
    const live = result ? result.confidence >= 80 : null;

    return (
        <div className="mx-auto flex h-full w-390 flex-col py-24">
            <h1 className="fz-20 font-bold text-[#1D1D1D]">Liveness bench</h1>
            <p className="fz-12 mt-4 leading-normal text-[#707070]">
                Runs the real AWS check with no sign-in around it. Cannot sign anyone in — it
                returns a score and nothing else. Each run costs one Face Liveness check. The
                check flashes coloured light.
            </p>

            {/* `rad-30`, matching FaceLivenessScreen exactly. It was `rad-20`,
                which is close enough to look deliberate and wrong enough to
                mislead: the checking glass meets the corner here, and judging
                how it reads against a radius the real screen does not have is
                the kind of review that approves something twice. */}
            <div className="relative isolate mt-16 h-400 w-350 shrink-0 self-center overflow-hidden rad-30 bg-black">
                {/* Same brackets as the real screen, so what is judged here is
                    what ships rather than a stripped-down cousin. */}
                {phase === 'streaming' && (
                    <CornerBrackets color="#FFEB00" inset={22} className="z-2" />
                )}

                {/* ⚠️ Mounted through `waiting` as well as `streaming`. The
                    detector is still uploading and analysing after the camera
                    goes; unmounting it there kills the run. See the same note
                    in FaceLivenessScreen. */}
                {(phase === 'streaming' || phase === 'waiting') && session && (
                    <LivenessCamera
                        sessionId={session.sessionId}
                        region={session.region}
                        credentialProvider={credentialProvider}
                        onAnalysisComplete={onComplete}
                        /* The camera has gone but AWS has not answered — the
                           five-to-ten-second window the bench used to spend
                           showing the SDK's black verifying screen. */
                        onStreamEnded={(capture) => {
                            // The still first, then the phase — same batching
                            // reason as FaceLivenessScreen: a `waiting` frame
                            // with no snapshot is glass over black.
                            if (capture) {
                                setShot(capture.display ?? capture.stored);
                                setShotPlain(capture.stored);
                            }
                            setPhase('waiting');
                        }}
                        onError={(err) => {
                            // `state` alone is a category, not a cause:
                            // RUNTIME_ERROR covers everything the detector did
                            // not classify, so on its own it says only
                            // "something threw". The message underneath is the
                            // part worth reading, and the console keeps the
                            // whole object for the stack.
                            console.error('[liveness-lab] detector error', err);
                            const detail = err?.error?.message ?? err?.error?.name ?? '';
                            setError(
                                [err?.state ?? 'detector error', detail]
                                    .filter(Boolean)
                                    .join(' — '),
                            );
                            setPhase('error');
                        }}
                    />
                )}

                {/* ── The captured still, once the camera is done with the frame
                    ──────────────────────────────────────────────────────────
                    The frame used to go black here and print the score into the
                    dark. The photo is the more useful thing to look at, and the
                    numbers read perfectly well below the frame. */}
                {phase !== 'streaming' && shot && (
                    <div
                        className="absolute inset-0"
                        style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element --
                            a data: URL, sized by CSS and never optimised; the
                            capture must stay byte-for-byte what was submitted. */}
                        <img
                            src={shot}
                            alt="captured frame"
                            onLoad={(e) =>
                                setShotSize({
                                    w: e.currentTarget.naturalWidth,
                                    h: e.currentTarget.naturalHeight,
                                })
                            }
                            className="absolute inset-0 h-full w-full object-cover"
                        />
                    </div>
                )}

                {/* ── The real checking state, on the bench ───────────────────
                    The exact component the sign-in shows while the servers
                    decide: the still under glass with the AI mark over it.
                    Reviewing it used to mean walking a whole sign-in, which is
                    the one thing this page exists to avoid.

                    `waiting` and `fetching` — the whole gap from the camera
                    stopping to the result landing. Once the result is in the
                    bench goes back to the sharp still below, because the
                    numbers are the point here.

                    `holdChecking` keeps it up indefinitely for review; see the
                    state declaration for why that is worth a control.

                    `onRetry` is a no-op: this only ever renders as `checking`,
                    which has no retry. The bench's Start button is the way
                    round again. */}
                {(phase === 'waiting' ||
                    phase === 'fetching' ||
                    (holdChecking && phase !== 'streaming')) && (
                    <LivenessVerdict
                        phase="checking"
                        snapshot={shot}
                        plainSnapshot={shotPlain}
                        onRetry={() => {}}
                    />
                )}

                {/* Nothing captured yet — the phase is the only news there is.
                    Not once the verdict is up: it owns those moments, and it
                    handles a missing still itself. */}
                {phase !== 'streaming' &&
                    phase !== 'waiting' &&
                    phase !== 'fetching' &&
                    !holdChecking &&
                    !shot && (
                    <div className="absolute inset-0 flex items-center justify-center px-20 text-center">
                        <span className="fz-13 text-white/70">
                            {phase === 'error' ? (error ?? 'error') : `${phase}…`}
                        </span>
                    </div>
                )}
            </div>

            {/* What the run produced. Unprocessed, and the pixel size is the
                honest measure of it. */}
            {shot && (
                <div className="mt-12 flex w-350 flex-col gap-8 self-center">
                    <div className="flex items-center gap-6">
                        <button
                            type="button"
                            onClick={() => setMirror((m) => !m)}
                            className="fz-11 h-28 flex-1 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                        >
                            {mirror ? 'Mirrored' : 'Raw side'}
                        </button>
                    </div>

                    <p className="fz-10 leading-normal text-[#707070]">
                        The capture as a person is shown it, through the look pipeline.
                        To see each stage on its own, what it measured, and the
                        untouched frame beside it, use the capture bench —
                        /design/capture-lab. It needs no AWS session.
                    </p>

                    <div className="fz-11 flex items-center justify-between text-[#707070]">
                        {/* The honest size of what we capture.
                            AWS asks the camera for 640x480 and offers no prop
                            to change it; `installCaptureQuality` raises the
                            request to 1280x960 before it is made. If this still
                            reads 640-ish, that lift did not take on this device
                            — which is the first thing to know and the reason
                            the number is printed. */}
                        <span>
                            captured {shotSize ? `${shotSize.w} × ${shotSize.h}` : '…'} ·{' '}
                            {Math.round((shot.length * 3) / 4 / 1024)} KB
                        </span>
                        <a
                            href={shot}
                            download="liveness-capture.jpg"
                            className="font-semibold text-primary underline"
                        >
                            save
                        </a>
                    </div>
                </div>
            )}

            <div className="mt-16 flex w-350 shrink-0 gap-8 self-center">
                <button
                    type="button"
                    onClick={() => void start()}
                    className="fz-14 h-48 flex-1 rad-12 bg-primary font-semibold text-white"
                >
                    Run again
                </button>

                {/* Costs nothing and needs no AWS session — the whole reason it
                    is here. The checking state is two seconds long in the real
                    thing and a real check every time you want another look at
                    it.

                    Disabled while the camera is live. The render above refuses
                    to draw over a stream anyway; this is so the control says
                    so rather than looking broken when pressing it does
                    nothing. */}
                <button
                    type="button"
                    disabled={phase === 'streaming'}
                    onClick={() => setHoldChecking((h) => !h)}
                    className={`fz-13 h-48 flex-1 rad-12 border font-semibold disabled:opacity-40 ${
                        holdChecking
                            ? 'border-primary text-primary'
                            : 'border-[#d5d5d5] text-[#1D1D1D]'
                    }`}
                >
                    {holdChecking ? 'Release checking' : 'Hold checking'}
                </button>
            </div>

            {/* ── The verdict, outside the frame ───────────────────────────────
                It used to be printed inside the camera box, which meant the
                frame had to be blanked to make room for it. */}
            {(result || phase === 'error') && (
                <div className="mt-16 flex w-350 flex-col items-center gap-4 self-center">
                    {result && (
                        <>
                            <span
                                className="fz-40 font-bold leading-none"
                                style={{ color: live ? '#34C759' : '#FF3B30' }}
                            >
                                {result.confidence.toFixed(1)}
                            </span>
                            <span className="fz-14 font-medium text-[#1D1D1D]">
                                {result.status}
                            </span>
                            <span
                                className="fz-12"
                                style={{ color: live ? '#34C759' : '#FF3B30' }}
                            >
                                {live ? 'reads as LIVE' : 'reads as NOT live'}
                            </span>
                            <span className="fz-11 text-[#707070]">
                                reference image {result.hasReferenceImage ? 'yes' : 'no'} ·{' '}
                                {result.auditImages} audit
                            </span>
                        </>
                    )}
                    {!result && phase === 'error' && (
                        <span className="fz-12 text-[#FF3B30]">{error ?? 'error'}</span>
                    )}
                </div>
            )}

            {log.length > 0 && (
                <div className="mt-16 flex flex-col gap-4">
                    <p className="fz-11 font-bold text-[#707070]">This session&apos;s runs</p>
                    {log.map((r, i) => (
                        <div
                            key={`${r.at}-${i}`}
                            className="fz-12 flex items-center justify-between py-3"
                            style={{ borderBottom: '1px solid #ececec' }}
                        >
                            <span className="text-[#707070]">{r.at}</span>
                            <span className="text-[#707070]">{r.status}</span>
                            <span
                                className="font-bold"
                                style={{ color: r.confidence >= 80 ? '#1a7f37' : '#c11' }}
                            >
                                {r.confidence.toFixed(1)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

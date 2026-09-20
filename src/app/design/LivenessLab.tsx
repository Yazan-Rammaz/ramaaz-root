'use client';

import { useCallback, useEffect, useState } from 'react';

import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { LivenessCamera } from '@/features/kyc/components/LivenessCamera';
import {
    BEAUTY_FILTER_CSS,
    BEAUTY_SOFT_BLUR,
    BEAUTY_SOFT_OPACITY,
} from '@/features/kyc/services/portrait';

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
 * The frame keeps the capture after the run instead of going black, so the
 * portrait pipeline can be judged without walking a sign-in: is the edge clean
 * around hair and shoulders, is the background blurred enough to lose the room
 * without looking smeared, is the look doing something or hiding something.
 *
 * The two toggles under the frame are for judging, not composing — the look
 * itself is not a per-run choice. It is applied to every capture and decided
 * in one place, `BEAUTY_FILTER_CSS` in services/portrait.ts.
 *
 * ⚠️ Two different edits, and the difference is the whole point:
 *
 *   - the BACKGROUND BLUR is baked into the file. It only touches pixels that
 *     are not the person, which is safe for the comparison that file is later
 *     put to;
 *   - the LOOK is CSS, applied only where the image is shown, and never
 *     written into it. Retouched skin is a face CompareFaces was not asked
 *     about.
 *
 * "Showing as submitted" turns the look off and leaves the file itself, which
 * is the copy that would reach the backend.
 *
 * The pixel size printed underneath is the other honest number here: it is
 * small, because AWS opens the camera at 640x480.
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

type Phase = 'idle' | 'starting' | 'streaming' | 'fetching' | 'done' | 'error';

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
    const [shotSize, setShotSize] = useState<{ w: number; h: number } | null>(null);

    /**
     * The capture is unmirrored — `drawImage` reads raw pixels, so the CSS
     * mirror the user watched themselves in is not in it. Mirroring it back is
     * the default because a face one has only ever seen mirrored looks subtly
     * wrong otherwise, and that would be mistaken for a quality problem.
     */
    const [mirror, setMirror] = useState(true);
    /** Show the submitted file as-is, with the presentation look switched off. */
    const [raw, setRaw] = useState(false);
    /**
     * What the camera did with CAMERA_ZOOM, reported by LivenessCamera.
     *
     * On screen rather than in the console because the device that matters here
     * is a phone, and "did the zoom apply" decides whether tuning that constant
     * can change the distance at all.
     */
    const [zoomInfo, setZoomInfo] = useState<string | null>(null);

    const start = useCallback(async () => {
        setPhase('starting');
        setResult(null);
        setError(null);
        setShot(null);
        setShotSize(null);
        setZoomInfo(null);
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
        async (snapshot: string | null) => {
            // Kept before anything can fail: the point of this page is now the
            // photo as much as the score, and a result fetch that 500s should
            // not also lose the capture.
            setShot(snapshot);
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

            <div className="relative mt-16 h-400 w-350 shrink-0 self-center overflow-hidden rad-20 bg-black">
                {/* Same brackets as the real screen, so what is judged here is
                    what ships rather than a stripped-down cousin. */}
                {phase === 'streaming' && (
                    <CornerBrackets color="#FFEB00" inset={22} className="z-2" />
                )}

                {phase === 'streaming' && session && (
                    <LivenessCamera
                        sessionId={session.sessionId}
                        region={session.region}
                        credentialProvider={credentialProvider}
                        onAnalysisComplete={onComplete}
                        onCameraZoom={setZoomInfo}
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
                            portrait must stay byte-for-byte what was produced
                            and submitted. */}
                        <img
                            src={shot}
                            alt="captured portrait"
                            onLoad={(e) =>
                                setShotSize({
                                    w: e.currentTarget.naturalWidth,
                                    h: e.currentTarget.naturalHeight,
                                })
                            }
                            className="absolute inset-0 h-full w-full object-cover"
                            style={{ filter: raw ? undefined : BEAUTY_FILTER_CSS }}
                        />
                        {/* The soft layer — the other half of the look. Sits
                            over the sharp image at a fraction of full strength,
                            so edges survive underneath and only skin texture is
                            filled in. */}
                        {!raw && (
                            // eslint-disable-next-line @next/next/no-img-element -- see above
                            <img
                                src={shot}
                                alt=""
                                aria-hidden
                                className="absolute inset-0 h-full w-full object-cover"
                                style={{
                                    filter: `${BEAUTY_FILTER_CSS} blur(${rem(BEAUTY_SOFT_BLUR)})`,
                                    opacity: BEAUTY_SOFT_OPACITY,
                                }}
                            />
                        )}
                    </div>
                )}

                {/* Nothing captured yet — the phase is the only news there is. */}
                {phase !== 'streaming' && !shot && (
                    <div className="absolute inset-0 flex items-center justify-center px-20 text-center">
                        <span className="fz-13 text-white/70">
                            {phase === 'error' ? (error ?? 'error') : `${phase}…`}
                        </span>
                    </div>
                )}
            </div>

            {/* ── What was produced ───────────────────────────────────────────
                No filter controls here any more, on purpose: the look is not a
                per-run choice, it is what every capture gets. `BEAUTY_FILTER_CSS`
                in services/portrait.ts is the one place it is decided.

                The two toggles that remain are for JUDGING the result rather
                than composing it — is the matte clean, and is the look doing
                something or hiding something. */}
            {shot && (
                <div className="mt-12 flex w-350 flex-col gap-8 self-center">
                    <div className="flex items-center gap-6">
                        <button
                            type="button"
                            onClick={() => setRaw((r) => !r)}
                            className="fz-11 h-28 flex-1 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                        >
                            {raw ? 'Showing as submitted' : 'Showing as presented'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setMirror((m) => !m)}
                            className="fz-11 h-28 flex-1 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                        >
                            {mirror ? 'Mirrored' : 'Raw side'}
                        </button>
                    </div>

                    <p className="fz-10 leading-normal text-[#707070]">
                        The file itself is the portrait — subject sharp, background blurred —
                        and that is what would be submitted. The look on top is CSS and is never
                        baked in: <code>{BEAUTY_FILTER_CSS}</code> plus a{' '}
                        {BEAUTY_SOFT_BLUR} blur layer at {BEAUTY_SOFT_OPACITY}.
                    </p>

                    <div className="fz-11 flex items-center justify-between text-[#707070]">
                        {/* The honest size of what we capture. Small, and the
                            reason is that AWS opens the camera at 640x480. */}
                        <span>
                            captured {shotSize ? `${shotSize.w} × ${shotSize.h}` : '…'} ·{' '}
                            {Math.round((shot.length * 3) / 4 / 1024)} KB
                            {zoomInfo ? ` · ${zoomInfo}` : ''}
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

            <button
                type="button"
                onClick={() => void start()}
                className="fz-14 mt-16 h-48 w-350 shrink-0 self-center rad-12 bg-primary font-semibold text-white"
            >
                Run again
            </button>

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

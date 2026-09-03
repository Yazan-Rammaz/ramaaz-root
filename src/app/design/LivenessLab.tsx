'use client';

import { useCallback, useEffect, useState } from 'react';

import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { LivenessCamera } from '@/features/kyc/components/LivenessCamera';

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

export function LivenessLab() {
    const [phase, setPhase] = useState<Phase>('idle');
    const [session, setSession] = useState<Session | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Every run this page has done, newest first — the actual output. */
    const [log, setLog] = useState<{ at: string; status: string; confidence: number }[]>([]);

    const start = useCallback(async () => {
        setPhase('starting');
        setResult(null);
        setError(null);
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

    const onComplete = useCallback(async () => {
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
    }, [sessionId]);

    // A spoof typically scores low but still reports SUCCEEDED, so the verdict
    // shown is drawn from the NUMBER, not the status. 80 is a starting point,
    // not a recommendation — the right threshold comes from your own runs.
    const live = result ? result.confidence >= 80 : null;

    return (
        <div className="mx-auto flex h-full w-390 flex-col py-24">
            <h1 className="fz-20 font-bold text-[#1D1D1D]">Liveness bench</h1>
            <p className="fz-12 mt-4 leading-normal text-[#707070]">
                Runs the real AWS check with no sign-in around it. Cannot sign anyone in — it
                returns a score and nothing else. Each run costs one Face Liveness check.
                The check flashes coloured light.
            </p>

            <div
                className="relative mt-16 h-400 w-350 shrink-0 self-center overflow-hidden rad-20 bg-black"
            >
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

                {phase !== 'streaming' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-12 px-20 text-center">
                        {result && (
                            <>
                                <span
                                    className="fz-40 font-bold"
                                    style={{ color: live ? '#34C759' : '#FF3B30' }}
                                >
                                    {result.confidence.toFixed(1)}
                                </span>
                                <span className="fz-14 font-medium text-white">
                                    {result.status}
                                </span>
                                <span
                                    className="fz-12"
                                    style={{ color: live ? '#34C759' : '#FF3B30' }}
                                >
                                    {live ? 'reads as LIVE' : 'reads as NOT live'}
                                </span>
                                <span className="fz-11 text-white/50">
                                    reference image {result.hasReferenceImage ? 'yes' : 'no'} ·{' '}
                                    {result.auditImages} audit
                                </span>
                            </>
                        )}
                        {!result && (
                            <span className="fz-13 text-white/70">
                                {phase === 'error' ? (error ?? 'error') : `${phase}…`}
                            </span>
                        )}
                    </div>
                )}
            </div>

            <button
                type="button"
                onClick={() => void start()}
                className="fz-14 mt-16 h-48 w-350 shrink-0 self-center rad-12 bg-primary font-semibold text-white"
            >
                Run again
            </button>

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

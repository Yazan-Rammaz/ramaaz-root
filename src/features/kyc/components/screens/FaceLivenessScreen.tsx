'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Icon } from '@/components/ui/Icon';
import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { LivenessCamera } from '@/features/kyc/components/LivenessCamera';
import { LivenessVerdict } from '@/features/kyc/components/LivenessVerdict';
import { api } from '@/features/kyc/services/kycApi';
import { createKycService } from '@/features/kyc/services';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The face check, done by Amazon Rekognition Face Liveness.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `FaceScanScreen` captures a single frame and the Worker runs CompareFaces on
 * it. CompareFaces answers "are these the same face" and nothing else, so a
 * photograph of the enrolled admin — held up on a second phone — passes. That
 * was demonstrated, not theorised.
 *
 * Face Liveness is a different service: it streams a short selfie video and
 * decides whether a live person was in front of the lens. It is certified
 * against ISO/IEC 30107-3 (iBeta PAD levels 1 and 2) for exactly the attack
 * that got through — printed photos, screens, replays, masks, deepfakes.
 *
 * ── The part that matters more than liveness ────────────────────────────────
 * The browser no longer chooses the image that gets compared. It sends a
 * SESSION ID; the Worker fetches the reference image from AWS itself and
 * compares that. Even a tampered client cannot submit a picture of its
 * choosing, which the single-frame flow could never prevent.
 *
 * ── What is ours and what is theirs ─────────────────────────────────────────
 * The title block and spacing below are ours; inside the frame, everything
 * except the camera surface and the oval is restyled by `LivenessCamera`. The
 * oval stays AWS's on purpose — it is drawn from the stream geometry that the
 * face-fit test also uses, so a restyled one would stop describing the test.
 *
 * ── Credentials in the browser ──────────────────────────────────────────────
 * Unavoidable: the component signs its own WebSocket to AWS and no server can
 * stand in the middle. They are minted per attempt by the Worker via STS,
 * expire in fifteen minutes, and permit exactly one action
 * (`rekognition:StartFaceLivenessSession`). This is the one sanctioned
 * exception to the rule that the browser only ever talks to our own origin —
 * `connect-src` in middleware.ts names the streaming host for that reason.
 */

type Phase = 'preparing' | 'ready' | 'checking' | 'passed' | 'failed';

type StartResponse = { sessionId: string; region: string };
type Credentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration?: string;
};

export function FaceLivenessScreen({
    challengeId,
    onSession,
    onPassed,
}: {
    /** Identifies the sign-in this check belongs to. Not a credential. */
    challengeId: string;
    /**
     * Hands the finished session id up. Returning an error rejects it and
     * re-arms the screen.
     *
     * The same seam `FaceScanScreen` uses for a captured frame, and for the
     * same reason: the caller is the only side holding the challenge token, so
     * a component driving a camera never sees a credential. What changed is
     * what crosses it — an id rather than an image, which is the whole point.
     * The Worker fetches the picture from AWS itself, so nothing this component
     * could be made to send can decide who is compared.
     */
    onSession: (sessionId: string) => Promise<{ error?: string } | void>;
    /**
     * Commit the verified step and move on. Called once the success animation
     * has played, NOT the moment the verdict lands.
     *
     * Split from `onSession` for one reason: committing navigates away, and a
     * server action that redirects never returns — so anything the screen wanted
     * to show after a pass had nowhere to happen. Verify, show, then commit.
     *
     * Optional: the design gallery and the bench have nothing to commit to.
     */
    onPassed?: () => Promise<{ error?: string } | void>;
}) {
    const t = useTranslations('auth');

    const [phase, setPhase] = useState<Phase>('preparing');
    const [session, setSession] = useState<StartResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** The last camera frame, shown while the servers decide. Never judged. */
    const [snapshot, setSnapshot] = useState<string | null>(null);
    /**
     * Bumped to run the whole check again on the SAME challenge.
     *
     * A failed face check does not burn the challenge — the backend allows
     * repeat attempts — so the retry re-arms the camera rather than sending the
     * user back for a fresh access link.
     *
     * ⚠️ Unlimited, deliberately and temporarily. The backend is to report how
     * many attempts remain; until it does there is nothing to count down from,
     * and inventing a client-side limit would lock people out of a check the
     * server was still willing to run. When that number arrives, this is where
     * it goes — and note that every attempt opens a NEW AWS Face Liveness
     * session, which is billed.
     */
    const [attempt, setAttempt] = useState(0);

    /**
     * Open a session and fetch credentials before rendering the detector.
     *
     * Both have to be in hand first: the component takes `sessionId` as a prop
     * and asks for credentials synchronously the moment it mounts, so starting
     * it early only produces a flash of its own error screen.
     */
    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const started = await createKycService().startReverify(challengeId);
                if (cancelled) return;
                if (!started?.sessionId) throw new Error('no session id');
                setSession(started);
                setPhase('ready');
            } catch {
                if (cancelled) return;
                setError(t('faceSetupFailed'));
                setPhase('failed');
            }
        })();

        return () => {
            cancelled = true;
        };
        // `attempt` is the retry trigger: AWS liveness sessions are single-use,
        // so going again means opening a new one, not reusing the last id.
    }, [challengeId, attempt, t]);

    /**
     * Handed to AWS's SDK, which calls it whenever it needs to sign. Fetching
     * per call rather than once keeps a long instruction pause from running
     * into the fifteen-minute expiry.
     */
    const credentialProvider = useCallback(async () => {
        const res = await api.kyc.reverifyCredentials<Credentials>(challengeId);
        if (!res.ok) throw new Error('Could not get liveness credentials');
        const { accessKeyId, secretAccessKey, sessionToken, expiration } = res.data;
        return {
            accessKeyId,
            secretAccessKey,
            sessionToken,
            expiration: expiration ? new Date(expiration) : undefined,
        };
    }, [challengeId]);

    /**
     * AWS is finished streaming. It does NOT tell us whether the person was
     * live — that verdict is fetched server-side from the session id, which is
     * the whole point. Ask the Worker.
     */
    // Hoisted out of the callback: an optional chain in a dependency array
    // defeats the React Compiler's memoisation ("Compilation Skipped"), and a
    // plain value does not.
    const sessionId = session?.sessionId ?? null;

    const handleComplete = useCallback(
        async (shot: string | null) => {
            if (!sessionId) return;
            // The still goes up first so the checking state has a face to scan
            // rather than a black box for the second or two this takes.
            setSnapshot(shot);
            setPhase('checking');
            try {
                const result = await onSession(sessionId);
                if (result?.error) {
                    setError(result.error);
                    setPhase('failed');
                    return;
                }
                setPhase('passed');

                // Let the success pulse play before committing, because
                // committing navigates and a redirect never comes back. Matched
                // to `verdict-burst` in globals.css — change one, change both.
                await new Promise((resolve) => setTimeout(resolve, 1100));

                const committed = await onPassed?.();
                if (committed?.error) {
                    setError(committed.error);
                    setPhase('failed');
                }
            } catch (err) {
                setError(err instanceof Error && err.message ? err.message : t('faceVerifyFailed'));
                setPhase('failed');
            }
        },
        [onSession, onPassed, sessionId, t],
    );

    return (
        <main className="flex h-full flex-col items-center justify-center">
            {/* Ours, and identical to FaceScanScreen's. */}
            <div className="flex flex-col items-center">
                <h1 className="fz-24 h-38 leading-none font-bold text-[#1D1D1D]">
                    {t('identityTitle')}
                </h1>
                <div className="flex items-center gap-6" style={{ marginTop: rem(12) }}>
                    <Icon name="kyc/face_detect" width={20} height={20} alt="" />
                    <span className="fz-14 leading-none font-medium text-[#1D1D1D]">
                        {t('liveFaceDetection')}
                    </span>
                </div>
                {/* The check flashes coloured light at you. AWS puts this on the
                    start screen we skip, so it belongs here — before it starts,
                    and where it can still be read. */}
                <p
                    className="fz-11 text-center leading-none font-medium text-[#707070]"
                    style={{ marginTop: rem(8) }}
                >
                    {t('livenessPhotosensitivity')}
                </p>
            </div>

            {/* Same 350 x 400 footprint as the frame it replaces, so the page
                rhythm is unchanged even though its contents are AWS's.

                No border: the camera fills it edge to edge, so the picture is
                the edge. */}
            <div
                className="relative h-400 w-350 shrink-0 overflow-hidden rad-30 bg-black"
                style={{ marginTop: rem(12), marginBottom: rem(70 + 12) }}
            >
                {phase === 'preparing' && (
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

                {/* Once the stream ends the camera is gone and the verdict owns
                    the frame — the still, the scan over it, then red or green.
                    Rendered ABOVE the camera in the tree so the swap is one
                    element appearing rather than two states racing. */}
                {(phase === 'checking' || phase === 'passed' || phase === 'failed') && (
                    <LivenessVerdict
                        phase={phase}
                        snapshot={snapshot}
                        onRetry={() => {
                            // Back to the camera on the same challenge. The
                            // still and the reason go first: leaving either up
                            // would show the last failure over the new attempt.
                            setSnapshot(null);
                            setError(null);
                            setPhase('preparing');
                            setAttempt((n) => n + 1);
                        }}
                    />
                )}

                {/* The same brackets the single-frame capture uses, so the two
                    face frames read as one screen rather than two.

                    Only while the camera is live: once the verdict takes the
                    frame it carries its own ring, and two coloured outlines at
                    once would be saying the same thing twice.

                    `z-2` because the mesh canvas inside the widget sits at z-1
                    and would otherwise paint over them. */}
                {(phase === 'preparing' || phase === 'ready') && (
                    <CornerBrackets color="#FFEB00" inset={22} className="z-2" />
                )}

                {phase === 'ready' && session && (
                    <LivenessCamera
                        sessionId={session.sessionId}
                        region={session.region}
                        credentialProvider={credentialProvider}
                        onAnalysisComplete={handleComplete}
                        onError={(err) => {
                            // The screen shows one fixed line by design, so
                            // without this a failure here leaves no trace
                            // anywhere. `state` is only a category —
                            // RUNTIME_ERROR covers everything unclassified — so
                            // log the whole object for the cause.
                            console.error('[liveness] detector error', err);
                            setError(t('faceSetupFailed'));
                            setPhase('failed');
                        }}
                    />
                )}
            </div>

            {/* The reason, and only when there is one worth reading.
                Zero-height so it cannot move the frame — same treatment as
                FaceScanScreen.

                The verdict inside the frame is wordless by design, but a backend
                that refused for a NAMED reason ("no enrolled selfie on file")
                must still say so: a red ring and a retry icon would send the
                user round a loop that cannot succeed. Generic failures stay
                silent and let the ring speak. */}
            {phase === 'failed' && error && error !== t('faceVerifyFailed') && (
                <div className="relative h-0 w-350">
                    <p
                        role="alert"
                        className="fz-12 absolute inset-x-0 px-20 text-center leading-normal font-medium text-[#FF3B30]"
                        style={{ top: rem(16) }}
                    >
                        {error}
                    </p>
                </div>
            )}
        </main>
    );
}

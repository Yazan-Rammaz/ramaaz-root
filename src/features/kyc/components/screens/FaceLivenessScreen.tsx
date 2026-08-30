'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

import { Icon } from '@/components/ui/Icon';
import { api } from '@/features/kyc/services/kycApi';
import { restartSignInAction } from '@/features/auth/actions';

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
 * ── What could not be matched to the design ─────────────────────────────────
 * The oval is AWS's and cannot be restyled. `FaceLivenessDetector` renders its
 * own camera surface and face guide, and exposes only two replaceable slots
 * (the photosensitivity warning and the error view) plus a flag to skip its
 * instruction screen. So the title block, spacing and colours below are ours;
 * everything inside the frame is theirs. That trade was made deliberately —
 * see the note in the design gallery entry.
 *
 * ── Credentials in the browser ──────────────────────────────────────────────
 * Unavoidable: the component signs its own WebSocket to AWS and no server can
 * stand in the middle. They are minted per attempt by the Worker via STS,
 * expire in fifteen minutes, and permit exactly one action
 * (`rekognition:StartFaceLivenessSession`). This is the one sanctioned
 * exception to the rule that the browser only ever talks to our own origin —
 * `connect-src` in middleware.ts names the streaming host for that reason.
 */

/**
 * `FaceLivenessDetectorCore`, not `FaceLivenessDetector`.
 *
 * They are the same component with different credential stories. The plain one
 * expects Amplify Auth — a Cognito identity pool — and its config type
 * explicitly `Omit`s `credentialProvider`, so it cannot be handed credentials
 * from elsewhere. Core exists for exactly our case: our own Worker mints them,
 * no Cognito, and therefore no `Amplify.configure()` at all.
 *
 * ── The two model files, and why they are ours ──────────────────────────────
 * Core's defaults fetch its TensorFlow WASM backend from cdn.jsdelivr.net and
 * its Blazeface model from tfhub.dev. Both are blocked here: `script-src` and
 * `connect-src` are `'self'`, deliberately, and a sign-in that depends on two
 * third-party CDNs staying up is a sign-in with two extra ways to fail. So they
 * are vendored into /public/vendor by scripts/sync-vendor.mjs — the same
 * treatment opencv.js and MediaPipe already get — and pointed at below.
 */
const TFJS_WASM_PATH = '/vendor/tfjs-wasm/';
const BLAZEFACE_MODEL_URL = '/vendor/blazeface/model.json';

/** The one place AWS's own palette is bent toward ours. */
const livenessTheme = createTheme({
    name: 'root-liveness',
    tokens: {
        colors: {
            background: { primary: { value: '#000000' } },
            font: { primary: { value: '#FFFFFF' } },
            brand: {
                primary: {
                    // The action blue, so its buttons are not AWS orange.
                    10: { value: '#EAF1FC' },
                    80: { value: '#3066CC' },
                    90: { value: '#2856AE' },
                    100: { value: '#1F4693' },
                },
            },
        },
        components: {
            button: { primary: { backgroundColor: { value: '#3066CC' } } },
        },
    },
});

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
    onPassed,
}: {
    /** Identifies the sign-in this check belongs to. Not a credential. */
    challengeId: string;
    /** Called once the Worker has accepted the result. */
    onPassed?: () => void;
}) {
    const t = useTranslations('auth');

    const [phase, setPhase] = useState<Phase>('preparing');
    const [session, setSession] = useState<StartResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

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
            const started = await api.kyc.reverifyStart<StartResponse>({ challengeId });
            if (cancelled) return;
            if (!started.ok || !started.data?.sessionId) {
                setError(t('faceSetupFailed'));
                setPhase('failed');
                return;
            }
            setSession(started.data);
            setPhase('ready');
        })();

        return () => {
            cancelled = true;
        };
    }, [challengeId, t]);

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
    const handleComplete = useCallback(async () => {
        setPhase('checking');
        const res = await api.kyc.reverifyVerify<{ status?: string; reason?: string }>({
            challengeId,
            sessionId: session?.sessionId,
        });

        if (!res.ok || res.data?.status !== 'passed') {
            setError(res.ok ? (res.data?.reason ?? t('faceVerifyFailed')) : t('faceVerifyFailed'));
            setPhase('failed');
            return;
        }
        setPhase('passed');
        onPassed?.();
    }, [challengeId, onPassed, session?.sessionId, t]);

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
            </div>

            {/* Same 350 x 400 footprint as the frame it replaces, so the page
                rhythm is unchanged even though its contents are AWS's. */}
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

                {phase !== 'preparing' && phase !== 'failed' && session && (
                    <ThemeProvider theme={livenessTheme}>
                        <FaceLivenessDetectorCore
                            sessionId={session.sessionId}
                            region={session.region}
                            // AWS's instruction screen duplicates the caption
                            // above and adds a tap nobody needs.
                            disableStartScreen
                            config={{
                                credentialProvider,
                                binaryPath: TFJS_WASM_PATH,
                                faceModelUrl: BLAZEFACE_MODEL_URL,
                            }}
                            onAnalysisComplete={handleComplete}
                            onError={() => {
                                setError(t('faceSetupFailed'));
                                setPhase('failed');
                            }}
                        />
                    </ThemeProvider>
                )}
            </div>

            {/* The only words on the screen, and only when something is wrong.
                Zero-height so it cannot move the frame — same treatment as
                FaceScanScreen. */}
            {phase === 'failed' && (
                <div className="relative h-0 w-350">
                    <div
                        className="absolute inset-x-0 flex flex-col items-center gap-12"
                        style={{ top: rem(16) }}
                    >
                        <p
                            role="alert"
                            className="fz-12 px-20 text-center leading-normal font-medium text-[#FF3B30]"
                        >
                            {error ?? t('faceVerifyFailed')}
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

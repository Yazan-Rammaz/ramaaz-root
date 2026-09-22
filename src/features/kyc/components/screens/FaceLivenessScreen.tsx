'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Icon } from '@/components/ui/Icon';
import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { LivenessCamera } from '@/features/kyc/components/LivenessCamera';
import { LivenessVerdict } from '@/features/kyc/components/LivenessVerdict';
import { CameraHandoffPanel } from '@/features/kyc/handoff/CameraHandoffPanel';
import { isShimInstalled } from '@/features/kyc/handoff/cameraShim';
import type { FaceCapture } from '@/features/kyc/services/faceCapture';
import { api } from '@/features/kyc/services/kycApi';
import { createKycService } from '@/features/kyc/services';
import {
    isChallengeExpired,
    KycHttpError,
} from '@/features/kyc/services/httpKycService';
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

type Phase =
    | 'preparing'
    | 'ready'
    | 'checking'
    | 'passed'
    /**
     * The check RAN and the person was not accepted. This is the only state
     * that earns the red ring.
     */
    | 'failed'
    /**
     * The check could not run at all — no camera, blocked permission, a session
     * that would not open, a detector that errored, a request that never
     * arrived.
     *
     * ⚠️ Split from `failed` deliberately. Both used to paint the frame red,
     * which told somebody whose CAMERA was blocked that their face had been
     * rejected. Nothing was compared; there was no verdict to show. A red ring
     * is an accusation, and it belongs only where something was actually
     * judged.
     */
    | 'unavailable';

/**
 * Challenges whose liveness check has already passed, with the still that was
 * on screen when it did.
 *
 * ── Why this is module-level and not state ──────────────────────────────────
 * Because the component REMOUNTS after it succeeds, and component state cannot
 * survive that. The sequence, from a real run:
 *
 *   verify → 200 passed          the check is over, and the backend has now
 *                                CONSUMED the re-verification challenge
 *   onPassed() → applyStage()    the stage advances and redirects
 *   …to /login/identity          the SAME route ID_DOCUMENT_REQUIRED maps to
 *   IdentityGate re-renders      `heldOpen` starts false again, so `enrolling`
 *                                is false for SUCCESS_HOLD_MS
 *   initialStep='face-reverify'  → this screen mounts FRESH
 *   start effect runs            → POST /reverify/start
 *   → 401 "Invalid or expired re-verification challenge"
 *   → setPhase('failed')         → the frame turns RED on a check that passed
 *
 * The 2-second success hold exists so the green frame can be seen. What it was
 * actually doing was re-mounting the liveness screen for two seconds after the
 * check had already succeeded, and the second AWS session it opened could only
 * ever be refused — the challenge behind it was spent by the verify that just
 * succeeded. The Worker's 401 was right; the second call was ours.
 *
 * So a pass is remembered HERE, outside the React tree. A remount reads it,
 * opens on the green verdict instead of the camera, and never calls start.
 *
 * Keyed by challenge, so it says nothing about any other sign-in, and it holds
 * no credential — a still and a boolean. A full page load clears it, which is
 * correct: by then the server's stage has moved on and this screen is not what
 * renders.
 */
const PASSED = new Map<string, string | null>();

/**
 * What to put on screen when the check could not RUN.
 *
 * Prefers whatever the service actually said. The generic line is a fallback
 * for a failure with no message at all, not the default — "Could not start the
 * face check" for every cause is what made a retry that failed again look
 * inexplicable, both to the administrator and to whoever they reported it to.
 *
 * `KycHttpError` carries the status, so a transport failure and a refusal read
 * differently instead of collapsing into one sentence.
 */
function noticeFor(err: unknown, fallback: string): string {
    if (err instanceof KycHttpError) {
        // The label `unwrap` prepends is for logs, not for a person.
        const detail = err.message.replace(/^[^:]+:\s*/, '').trim();
        return detail || fallback;
    }
    if (err instanceof Error && err.message) return err.message;
    return fallback;
}

/**
 * Is this a device AWS will refuse to run a liveness check on right now?
 *
 * ⚠️ Face Liveness does not work in landscape on a mobile device. It is not a
 * degraded experience, it is a refusal: the detector raises
 * `MOBILE_LANDSCAPE_ERROR` and never opens the camera.
 *
 * This mirrors the SDK's own test exactly — `isMobileScreen()` and
 * `getLandscapeMediaQuery()` in its `utils/device.mjs`, including the iPadOS 13+
 * case where an iPad reports a Macintosh user agent and is identified by having
 * touch points instead. Mirrored rather than imported because neither helper is
 * exported from the package; if the SDK's test ever diverges from this one, the
 * symptom is the guard disagreeing with the detector, so it is worth rechecking
 * on an upgrade.
 *
 * Testing it OURSELVES, before mounting the detector, is the whole point: a
 * check started in landscape opens a billed AWS session and a backend
 * validation round-trip, and then throws all of it away. Asking someone to turn
 * their tablet upright first costs nothing.
 */
/**
 * Turn the screen to portrait on the user's behalf.
 *
 * Returns false when the browser will not do it, which is not an edge case —
 * it is every iPhone and iPad. `screen.orientation.lock` is unimplemented in
 * Safari, so on exactly the devices most likely to be held sideways this button
 * cannot work and the written instruction is the whole answer. Hence a boolean
 * rather than a throw: the caller keeps the manual wording on screen.
 *
 * ⚠️ Fullscreen first, and not optional. Chrome refuses an orientation lock
 * outside fullscreen ("screen.orientation.lock() requires that the document be
 * fullscreen"), so a lock attempted on its own silently rejects and the button
 * looks broken.
 */
async function lockPortrait(): Promise<boolean> {
    try {
        const orientation = window.screen?.orientation as
            | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
            | undefined;
        if (typeof orientation?.lock !== "function") return false;

        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen?.();
        }
        await orientation.lock("portrait");
        return true;
    } catch {
        // Denied, unsupported, or the gesture was not trusted. The written
        // instruction above is still correct, so this stays quiet.
        return false;
    }
}

function isMobileDevice(): boolean {
    if (typeof navigator === "undefined") return false;
    const newerIpad =
        /Macintosh/i.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
    return /Android|iPhone|iPad/i.test(navigator.userAgent) || newerIpad;
}

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
    onFaceCaptured,
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
    onPassed?: (faceCapturedPhoto: string | null) => Promise<{ error?: string } | void>;
    /**
     * The frame this check ended on, for the steps that follow.
     *
     * The enrolment screens compare the ID document against the face captured
     * HERE, so the admin never photographs themselves twice — the single-frame
     * capture has always fed that, and without this the liveness path left the
     * ID-match screen with no face to compare against at all.
     *
     * Presentational, like the still itself: this is not the image AWS judged.
     */
    onFaceCaptured?: (capture: FaceCapture | null) => void;
}) {
    const t = useTranslations('auth');

    // Seeded from PASSED so a remount AFTER a successful check opens on the
    // green verdict rather than flashing the camera and then failing. See the
    // note on PASSED — this is the whole reason it exists.
    const [phase, setPhase] = useState<Phase>(() =>
        PASSED.has(challengeId) ? 'passed' : 'preparing',
    );
    const [session, setSession] = useState<StartResponse | null>(null);
    /** Why the check could not run. Shown with `unavailable`, never with a ring. */
    const [notice, setNotice] = useState<string | null>(null);
    /** The last camera frame, shown while the servers decide. Never judged. */
    const [snapshot, setSnapshot] = useState<string | null>(() => PASSED.get(challengeId) ?? null);
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
     * The camera frame. Handed to the hand-off panel, which mounts BELOW the
     * frame (nothing clips its caption there) and portals its QR overlay back
     * in. The frame is `overflow-hidden`, so a caption positioned outside it
     * from within is simply never seen.
     */
    const frameRef = useRef<HTMLDivElement>(null);

    /**
     * Landscape on a phone or tablet — the one state where starting the check
     * is guaranteed to fail.
     *
     * Starts false and is set in an effect rather than read during render:
     * `matchMedia` does not exist on the server, and a first paint that
     * disagreed with the client would hydrate-mismatch.
     */
    const [mustRotate, setMustRotate] = useState(false);
    /** Set once the rotate button has been tried and the browser refused. */
    const [rotateManually, setRotateManually] = useState(false);

    useEffect(() => {
        if (!isMobileDevice()) return;
        const query = window.matchMedia("(orientation: landscape)");
        const apply = () => setMustRotate(query.matches);
        apply();
        // Turning the device is the fix, so the prompt has to clear itself the
        // moment they do — and then the start effect below runs on its own.
        query.addEventListener("change", apply);
        return () => query.removeEventListener("change", apply);
    }, []);

    /**
     * Open a session and fetch credentials before rendering the detector.
     *
     * Both have to be in hand first: the component takes `sessionId` as a prop
     * and asks for credentials synchronously the moment it mounts, so starting
     * it early only produces a flash of its own error screen.
     */
    useEffect(() => {
        // Already passed. Opening another AWS session would spend a billed
        // session to ask about a challenge the backend has already retired, and
        // the only possible answer is the 401 that used to paint this frame red.
        if (PASSED.has(challengeId)) return;

        // Landscape on mobile: do not open anything. The detector would refuse
        // with MOBILE_LANDSCAPE_ERROR after we had already paid for an AWS
        // session and a backend validate. `mustRotate` is a dependency, so
        // turning the device upright runs this effect for real.
        if (mustRotate) return;

        let cancelled = false;

        void (async () => {
            try {
                const started = await createKycService().startReverify(challengeId);
                if (cancelled) return;
                if (!started?.sessionId) throw new Error('no session id');
                setSession(started);
                setPhase('ready');
            } catch (err) {
                if (cancelled) return;
                console.error('[liveness] could not open a session:', err);

                // ⚠️ 401 is the CHALLENGE, not the camera — expired, spent, or
                // burned through its attempts. Retrying the step cannot work:
                // the backend answers identically every time, which is exactly
                // why the retry button "always failed for no reason".
                //
                // A dead challenge is not a dead LINK, though. Re-opening the
                // link mints a fresh one and drops the administrator back at
                // whichever step the server now says is owed — so the recovery
                // is to open it again rather than to end the sign-in.
                // `restartSignInAction` is `/enter/<token>` in everything but
                // name: it spends the STORED link token server-side, so the
                // token never travels through a URL a second time. With no
                // stored link it falls through to /no-access on its own, which
                // is then the honest answer.
                if (isChallengeExpired(err)) {
                    void restartSignInAction();
                    return;
                }

                // ⚠️ Say WHAT went wrong.
                //
                // This showed one fixed sentence for every cause, so pressing
                // retry and failing again gave the user — and us — nothing to
                // act on. The Worker and the backend both answer with a real
                // message; it just was not being read.
                setNotice(noticeFor(err, t('faceSetupFailed')));
                setPhase('unavailable');
            }
        })();

        return () => {
            cancelled = true;
        };
        // `attempt` is the retry trigger: AWS liveness sessions are single-use,
        // so going again means opening a new one, not reusing the last id.
    }, [challengeId, attempt, t, mustRotate]);

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
        async (capture: FaceCapture | null) => {
            if (!sessionId) return;
            /*
             * Two images, and they are not interchangeable.
             *
             * `display` carries any edit that is worth showing but not worth
             * submitting — the portrait blur, which softens the hair and jaw
             * boundary along with the room. `stored` is the photograph of
             * record, and every path that hands the image to a server takes
             * that one. `config/capture.ts` (CAPTURE_OUTPUT) decides which
             * stages land in which, and argues each.
             *
             * They are the same string whenever nothing display-only ran,
             * which is the default.
             */
            const shot = capture?.stored ?? null;
            const shown = capture?.display ?? shot;

            // The still goes up first so the checking state has a face to scan
            // rather than a black box for the second or two this takes.
            setSnapshot(shown);
            onFaceCaptured?.(capture);
            setPhase('checking');

            try {
                const result = await onSession(sessionId);
                if (result?.error) {
                    console.error('[liveness] refused:', result.error);
                    setPhase('failed');
                    return;
                }
            } catch (err) {
                console.error('[liveness] verify threw:', err);
                // Same reasoning as the session-open path: re-open the link
                // rather than ending the sign-in.
                if (isChallengeExpired(err)) {
                    void restartSignInAction();
                    return;
                }
                setNotice(noticeFor(err, t('faceSetupFailed')));
                setPhase('unavailable');
                return;
            }

            // Recorded BEFORE the commit below, because the commit redirects
            // and the redirect is what remounts this screen. Written any later
            // and the remount would race it and start a session anyway.
            // The DISPLAYED still, because this is only ever read back to
            // repaint this frame after a remount — see the note at PASSED.
            // Seeding it with `stored` would make the picture change the moment
            // the screen re-mounted, which reads as a second, different capture.
            PASSED.set(challengeId, shown);
            setPhase('passed');

            // Let the success pulse play before committing, because committing
            // navigates and a redirect never comes back. Matched to
            // `verdict-burst` in globals.css — change one, change both.
            await new Promise((resolve) => setTimeout(resolve, 1100));

            try {
                // The frame goes WITH the commit. It is the same still the
                // verdict showed — a base64 data URL — and the backend stores
                // it so a refresh on the ID step has a face to display without
                // asking anyone to photograph themselves twice.
                const committed = await onPassed?.(shot);
                if (committed?.error) {
                    console.error('[liveness] commit refused:', committed.error);
                    setPhase('failed');
                }
            } catch (err) {
                // ⚠️ A Server Action that redirects signals by THROWING, and
                // that throw IS the success path. Catching it as a failure is
                // what turned every passed check green and then instantly red.
                //
                // Next tags its own control-flow errors with a `digest` — let
                // those through so the navigation happens. Anything else is a
                // real commit failure and belongs on screen.
                const digest = (err as { digest?: unknown } | null)?.digest;
                if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) throw err;
                console.error('[liveness] commit threw:', err);
                // Through noticeFor, like the two paths above. This threw the
                // error away and showed the generic line, which put a check
                // that PASSED and then failed to commit behind the same words
                // as a camera that never opened — indistinguishable on screen,
                // and the two need completely different fixes.
                setNotice(noticeFor(err, t('faceSetupFailed')));
                setPhase('unavailable');
            }
        },
        // `t` is in here because the non-verdict paths above now render a
        // message through it. Omitted, a language switch mid-check would leave
        // this callback closed over the previous locale's strings.
        [onSession, onPassed, onFaceCaptured, sessionId, challengeId, t],
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
                ref={frameRef}
                /*
                  LTR in every language — same exception as the other camera
                  frames (IDCaptureScreen, FaceScanScreen), and here it covers a
                  third party as well as us.

                  AWS's widget lays its own chrome out in flex and positions the
                  oval from the VIDEO STREAM's geometry — the same geometry the
                  face-fit test reads. It has no RTL mode and was never written
                  for one, so under `<html dir="rtl">` its hint, Rec badge and
                  match-indicator mirror while the oval underneath them does
                  not. `liveness.css` then styles a layout that is no longer the
                  one it was written against (see its `margin-top: auto` note).

                  Pinning the frame means Arabic gets byte-identical behaviour
                  to English inside the camera. The screen's own copy is outside
                  this box and still mirrors.
                */
                dir="ltr"
                className="relative h-400 w-350 shrink-0 overflow-hidden rad-30 bg-black"
                style={{ marginTop: rem(12), marginBottom: rem(70 + 12) }}
            >
                {/*
                  Turn the device — shown INSTEAD of starting anything.

                  Not an error state: nothing has failed, and nothing has been
                  spent. Face Liveness simply does not run in landscape on a
                  phone or tablet, so this is the one obstacle the person can
                  clear themselves in a second. It clears itself when they do.
                */}
                {mustRotate && (
                    <div
                        role="status"
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 px-24"
                    >
                        {/* Tapping it turns the screen where the browser allows
                            that; where it does not, the text below is the way. */}
                        <button
                            type="button"
                            onClick={() => {
                                void lockPortrait().then((locked) => {
                                    if (!locked) setRotateManually(true);
                                });
                            }}
                            title={t('faceRotateTitle')}
                            aria-label={t('faceRotateTitle')}
                            className="flex h-56 w-56 items-center justify-center rounded-full border border-white/40 text-white transition-colors hover:border-white"
                        >
                            <Icon name="kyc/retry" size={26} mask />
                        </button>
                        <p
                            className="fz-16 text-center leading-none font-semibold text-white"
                            style={{ marginTop: rem(16) }}
                        >
                            {t('faceRotateTitle')}
                        </p>
                        <p
                            className="fz-13 max-w-300 text-center leading-normal font-medium text-white/80"
                            style={{ marginTop: rem(8) }}
                        >
                            {rotateManually ? t('faceRotateManual') : t('faceRotateBody')}
                        </p>
                    </div>
                )}

                {phase === 'preparing' && !mustRotate && (
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
                            setPhase('preparing');
                            setAttempt((n) => n + 1);
                        }}
                    />
                )}

                {/*
                  Could not RUN — no ring, no verdict, no accusation.

                  Plain dark panel and a retry. This is where a blocked camera,
                  a missing device, a sub-15fps camera and a refused session all
                  land, and none of them looked at anybody's face. The red ring
                  above stays for the one case that did.
                */}
                {phase === 'unavailable' && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 px-24">
                        <p className="fz-14 max-w-300 text-center leading-normal font-medium text-white">
                            {notice ?? t('faceSetupFailed')}
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                setNotice(null);
                                setSnapshot(null);
                                setPhase('preparing');
                                setAttempt((n) => n + 1);
                            }}
                            title={t('deviceRetry')}
                            aria-label={t('deviceRetry')}
                            className="flex h-40 w-40 items-center justify-center rad-12 border border-white/40 text-white transition-colors hover:border-white"
                            style={{ marginTop: rem(16) }}
                        >
                            <Icon name="kyc/retry" size={20} mask />
                        </button>
                    </div>
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
                            // `state` is only a category — RUNTIME_ERROR covers
                            // everything unclassified — so log the whole object
                            // for the cause. The screen now names the state too,
                            // but the object is what says why.
                            console.error('[liveness] detector error', err);

                            // ⚠️ NEVER `failed`. Everything that reaches here is
                            // the camera, not the face: a blocked permission, no
                            // device, a device that cannot sustain 15fps
                            // (CAMERA_FRAMERATE_ERROR), a detector that threw.
                            // Not one of them compared anybody to anything, and
                            // painting the frame red for them tells the user
                            // their face was rejected when their camera never
                            // opened.
                            const state = (err as { state?: string } | null)?.state ?? '';

                            // ⚠️ CAMERA_FRAMERATE_ERROR has two very different
                            // causes and the message cannot tell them apart:
                            //
                            //   - the camera in use genuinely reports under
                            //     15fps in `getSettings()`, which AWS refuses
                            //     (machine.mjs), or
                            //   - a relayed hand-off track is being used and the
                            //     shim that teaches it to describe itself was
                            //     not applied.
                            //
                            // One is a device limit the user must route around;
                            // the other is our bug. Guessing between them has
                            // already cost two rounds, so the next occurrence
                            // says which. No image, no identifiers — the shim
                            // flag and what the devices claim.
                            if (/FRAMERATE/i.test(state)) {
                                void (async () => {
                                    const devices = await navigator.mediaDevices
                                        .enumerateDevices()
                                        .catch(() => []);
                                    console.warn('[liveness] framerate refusal', {
                                        handoffShimInstalled: isShimInstalled(),
                                        videoInputs: devices
                                            .filter((d) => d.kind === 'videoinput')
                                            .map((d) => d.label || '(unlabelled)'),
                                    });
                                })();
                            }
                            // ⚠️ Say WHICH failure, the same way the session and
                            // verify paths above already do.
                            //
                            // Only ACCESS was ever named here; every other state
                            // — framerate, timeout, server, a detector that
                            // threw — showed the same "Could not start the face
                            // check", and the one string that identified it went
                            // to the console and nowhere else. On a tablet with
                            // no console attached that is unreportable: the
                            // administrator sees a black panel and a retry that
                            // fails identically, and so does whoever they tell.
                            //
                            // Framerate gets its own line because it is the one
                            // the user can route around unaided — the hand-off
                            // borrows a phone camera that can hold 15fps. Any
                            // state we have no wording for still carries its
                            // code, so the next screenshot names itself.
                            setNotice(
                                /ACCESS|PERMISSION|DENIED/i.test(state)
                                    ? t('faceCameraBlocked')
                                    : /FRAMERATE/i.test(state)
                                      ? t('faceCameraFramerate')
                                      : // Backstop only — the guard above should
                                        // mean we never mount the detector in
                                        // landscape. Kept because the SDK's own
                                        // test is the authority, and if the two
                                        // ever disagree this must still say
                                        // something a person can act on.
                                        /LANDSCAPE/i.test(state)
                                        ? t('faceRotateBody')
                                        : state
                                          ? t('faceSetupFailedCode', { code: state })
                                          : t('faceSetupFailed'),
                            );
                            setPhase('unavailable');
                        }}
                    />
                )}
            </div>

            {/*
              The phone-camera hand-off. Mounted OUTSIDE the frame so its
              caption is not clipped by the frame's `overflow-hidden`; the QR
              overlay is portalled back in via `frameRef`.

              `onLive` bumps `attempt`, which is the retry trigger — a new AWS
              session and a fresh <LivenessCamera>. That remount is what calls
              getUserMedia again and so picks up the shimmed stream. The widget
              acquires its camera internally and cannot be handed one, so a
              remount is the only way in; without this the QR would connect and
              the frame would stay dead.
            */}
            <CameraHandoffPanel
                frameRef={frameRef}
                facing="user"
                // Live video is wanted only while the camera is actually
                // running. From `checking` onward AWS already has what it will
                // judge, so the phone freezes on the captured frame rather than
                // filming somebody waiting for a verdict — and goes live again
                // if the check re-arms for another attempt.
                cameraLive={phase === 'preparing' || phase === 'ready'}
                onLive={() => {
                    setSnapshot(null);
                    setPhase('preparing');
                    setAttempt((n) => n + 1);
                }}
            />

            {/* Nothing is written under the frame.

                A reason used to print here when the backend named one. It is
                gone by request: the ring and the retry carry the outcome, and a
                line of red text appearing under a screen that has just gone
                green reads as a failure even when it is not.

                The reason is NOT discarded — `error` still holds it and it is
                logged at the point of failure, so a support call can still be
                answered. It is simply not on the screen. */}
        </main>
    );
}

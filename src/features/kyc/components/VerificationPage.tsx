'use client';

import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { restartSignInAction } from '@/features/auth/actions';
import IntroScreen from './screens/IntroScreen';
import IDCaptureScreen from './screens/IDCaptureScreen';
import IDSummaryScreen from './screens/IDSummaryScreen';
import FaceMatchScreen, { type EnrolmentInput } from './screens/FaceMatchScreen';
import SuccessScreen from './screens/SuccessScreen';
import ContactSupportScreen from './screens/ContactSupportScreen';
import AwsFaceLivenessScreen from './screens/AwsFaceLiveness';
import { FaceScanScreen } from './screens/FaceScanScreen';
import { FaceLivenessScreen } from './screens/FaceLivenessScreen';

const transition = { duration: 0.35, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * The face step cannot run: this sign-in has no challenge id.
 *
 * Deliberately offers only "start over". There is nothing to retry here — the
 * challenge is what the whole step is scoped to, and a fresh access link is the
 * only thing that produces a new one.
 */
function MissingChallenge() {
    const t = useTranslations('auth');
    return (
        <main className="flex h-full flex-col items-center justify-center gap-12 px-24">
            <p role="alert" className="fz-14 text-center leading-normal font-medium text-[#FF3B30]">
                {t('faceSetupFailed')}
            </p>
            <button
                type="button"
                className="fz-14 text-primary leading-none font-semibold underline"
                onClick={() => void restartSignInAction()}
            >
                {t('startOver')}
            </button>
        </main>
    );
}

export default function VerificationPage({
    onCapture,
    onReverified,
    challengeId,
    onLivenessSession,
    onLivenessPassed,
    faceVerified = false,
    onEnroll,
}: {
    /**
     * Submits the captured face. Returns an error to reject it and let the
     * screen re-arm; returning nothing means the step passed.
     *
     * The caller owns the exchange because it is the only side holding the
     * challenge token — a component driving a webcam never sees a credential.
     */
    onCapture?: (frame: string) => Promise<{ error?: string } | void>;
    /** Called once the face check has passed. */
    onReverified?: () => void;
    /**
     * The server has accepted the captured face. Passed straight through to
     * the capture screen so it can stop scanning and go green — it cannot work
     * this out for itself, because the action that carries the good news
     * redirects, and a redirect never returns to the caller.
     */
    faceVerified?: boolean;
    /**
     * Submits the ID enrolment once the face has matched the document. Owned by
     * the caller for the same reason `onCapture` is — see FaceMatchScreen's
     * `EnrolmentInput`.
     */
    onEnroll?: (input: EnrolmentInput) => Promise<{ error?: string } | void>;
    /**
     * The sign-in this check belongs to. Present only in the real flow; the
     * design gallery mounts these screens without one.
     */
    challengeId?: string;
    /**
     * Submits a finished AWS liveness session. Supplying this (with a
     * challengeId) is what selects Face Liveness over the single-frame capture
     * — see the `face-reverify` case below.
     */
    onLivenessSession?: (sessionId: string) => Promise<{ error?: string } | void>;
    /** Commits the verified step, after the success animation. */
    onLivenessPassed?: (faceCapturedPhoto: string | null) => Promise<{ error?: string } | void>;
} = {}) {
    const { currentStep, direction, setLivenessResult } = useVerification();

    // NOTHING RUNS ON MOUNT, deliberately.
    //
    // This used to check KYC status, open a session and route to /home. All
    // three were RDB assumptions that do not hold here:
    //
    //   - both calls need a SESSION, and this flow runs mid-challenge before
    //     any token exists, so they answered 401 twice on every mount;
    //   - whether this admin is already verified is the STAGE the server
    //     returned, not something to re-derive from a status endpoint;
    //   - and where to go next is the server's decision, delivered by
    //     applyStage(). A client-side push would race that redirect.

    const variants = {
        enter: { x: direction * 100 + '%', opacity: 0 },
        center: { x: 0, opacity: 1 },
        exit: { x: direction * -100 + '%', opacity: 0 },
    };

    const renderStep = () => {
        switch (currentStep) {
            case 'intro':
                return <IntroScreen />;
            case 'face-reverify':
                // AWS Rekognition Face Liveness when the caller supplied a
                // challenge id and a handler for the session — which the real
                // sign-in always does. A photograph on a second phone passed the
                // single-frame check below; this one streams a short video and
                // AWS decides whether a live person was there.
                //
                // FaceScanScreen is still the fallback, and still reachable from
                // the design gallery, because it is what runs if this component
                // is ever mounted without that pair.
                if (challengeId && onLivenessSession) {
                    return (
                        <FaceLivenessScreen
                            challengeId={challengeId}
                            onSession={onLivenessSession}
                            onPassed={onLivenessPassed}
                            // The enrolment steps compare the ID against the
                            // face captured here, so the admin never
                            // photographs themselves twice. The single-frame
                            // branch below has always done this; without it the
                            // liveness path reached the ID-match screen with no
                            // face to compare against.
                            onFaceCaptured={(frame) => {
                                if (!frame) return;
                                setLivenessResult({
                                    isLive: true,
                                    faceImageData: frame,
                                    timestamp: Date.now(),
                                });
                            }}
                        />
                    );
                }
                // ── Half a pair is a broken sign-in, not a weaker one ─────────
                //
                // The gallery mounts this with NEITHER, and falls through to the
                // capture below — that is the fallback's purpose. But the real
                // flow always passes `onLivenessSession`, so having it WITHOUT a
                // challenge id means a real sign-in lost its challenge, and
                // quietly handing that user the single-frame camera would be
                // downgrading the anti-spoofing check exactly when something has
                // already gone wrong.
                //
                // It would not even work: the Worker now refuses
                // `liveFaceImageData` for this tenant, so the capture ends in a
                // generic failure after the user has held still for it. Saying
                // so up front costs them nothing and tells them what to do.
                if (onLivenessSession && !challengeId) {
                    return <MissingChallenge />;
                }
                // The capture designed for this flow: one black frame, yellow
                // corner brackets, automatic capture once the local gate is
                // satisfied. The older FaceReverifyScreen carried rdb's own
                // look and its own 3-attempt counter — attempts now belong to
                // the backend, which burns the challenge itself.
                return (
                    <FaceScanScreen
                        verified={faceVerified}
                        onCapture={async (frame) => {
                            // Kept for the enrolment steps that follow: the ID
                            // is compared against THIS frame, so the admin never
                            // captures their face twice.
                            setLivenessResult({
                                isLive: true,
                                faceImageData: frame,
                                timestamp: Date.now(),
                            });
                            const result = await onCapture?.(frame);
                            if (result?.error) return { error: result.error };
                            onReverified?.();
                            return undefined;
                        }}
                    />
                );
            case 'face-detection':
                return <AwsFaceLivenessScreen />;
            case 'id-capture-front':
            case 'id-capture-back':
                return <IDCaptureScreen />;
            case 'id-summary':
                return <IDSummaryScreen />;
            case 'face-match':
                return <FaceMatchScreen onEnroll={onEnroll} />;
            case 'success':
                return <SuccessScreen />;
            case 'contact-support':
                return <ContactSupportScreen />;
            default:
                return <IntroScreen />;
        }
    };

    // The screens are drawn on the 430 XD canvas, so the ROUTE supplies the page
    // wrapper — `<Screen variant="centered" maxW={430} gutter={0} className="h-full">`
    // — which is this project's shape for what rdb got from `<Page variant="scaled">`
    // plus its outer-bg letterbox. (rdb tinted the letterbox cream on the intro
    // step via outerBg="intro"; here IntroScreen paints that colour itself, and
    // anything outside the 430 column is the dashboard background.)
    //
    // This component owns only the step stage: a positioned, height-bounded box
    // that each screen fills with `h-full`.
    return (
        <div className="relative h-full overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
                <motion.div
                    key={currentStep}
                    variants={variants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={transition}
                    className="absolute inset-0 w-full h-full"
                >
                    {renderStep()}
                </motion.div>
            </AnimatePresence>
        </div>
    );
}

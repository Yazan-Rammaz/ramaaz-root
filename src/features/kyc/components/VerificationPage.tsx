'use client';

import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useRouter } from 'next/navigation';
import { api } from '@/features/kyc/services/kycApi';
import { KycVerificationStatus } from '@/features/kyc/types/verification';
import IntroScreen from './screens/IntroScreen';
import IDCaptureScreen from './screens/IDCaptureScreen';
import IDSummaryScreen from './screens/IDSummaryScreen';
import FaceMatchScreen from './screens/FaceMatchScreen';
import SuccessScreen from './screens/SuccessScreen';
import ContactSupportScreen from './screens/ContactSupportScreen';
import AwsFaceLivenessScreen from './screens/AwsFaceLiveness';
import FaceReverifyScreen from './screens/FaceReverifyScreen';

const transition = { duration: 0.35, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

export default function VerificationPage({
    challengeId,
    onReverified,
}: {
    /** Server-issued id for the every-login face check. */
    challengeId?: string;
    /** Receives the server's step token when the face check passes. */
    onReverified?: (stepToken: string) => void;
} = {}) {
    const { currentStep, direction, setKycSessionId, goTo } = useVerification();
    const router = useRouter();
    const checkedRef = useRef(false);

    // On mount: check existing KYC status, fetch a fresh session, and route accordingly
    useEffect(() => {
        if (checkedRef.current) return;
        checkedRef.current = true;

        (async () => {
            try {
                // 1. Check existing KYC status.
                const statusRes = await api.kyc.status();
                const status = statusRes.ok ? statusRes.data.status : undefined;

                if (status === KycVerificationStatus.VERIFIED) {
                    router.push('/home');
                    return;
                }

                // 2. Fetch a fresh kycSessionId. Refresh-on-401 matters here: an
                // expired access token would otherwise leave kycSessionId null and
                // the flow would later skip submit ("Missing verification data").
                const sessionRes = await api.kyc.startSession();
                if (sessionRes.ok) {
                    const sessionId = sessionRes.data.sessionId;
                    if (sessionId) {
                        setKycSessionId(sessionId);
                    } else {
                        console.error(
                            '[VerificationPage] session response had no sessionId:',
                            sessionRes.data,
                        );
                    }
                } else {
                    console.warn(
                        '[VerificationPage] session fetch failed:',
                        sessionRes.error.message,
                    );
                }

                // 3. Route based on status already fetched in step 1.
                // The video interview was removed, so there is no in-app step for
                // a 'pending' record to resume into — and the backend blocks
                // re-submission while pending. Send them home.
                if (status === 'pending') {
                    router.push('/home');
                    return;
                }
                // 'rejected' or null → stay on intro
            } catch {
                // Silent — stay on intro
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                return (
                    <FaceReverifyScreen
                        challengeId={challengeId ?? ''}
                        onPassed={(stepToken) => onReverified?.(stepToken)}
                        onExhausted={() => goTo('contact-support')}
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
                return <FaceMatchScreen />;
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

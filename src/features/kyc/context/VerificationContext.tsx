'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type {
    VerificationStep,
    LivenessResult,
    IDDocument,
    MatchResult,
} from '@/features/kyc/types/verification';

interface VerificationContextType {
    currentStep: VerificationStep;
    direction: 1 | -1;
    completedSteps: Set<VerificationStep>;
    attemptCounts: Record<string, number>;
    livenessResult: LivenessResult | null;
    /**
     * The face captured earlier in this sign-in, served by /api/face-capture.
     *
     * ⚠️ DISPLAY ONLY, and the distinction is load-bearing. `livenessResult`
     * holds the actual captured BYTES and is what the enrolment posts; this is
     * a URL to a picture of the same face, and posting it would send a link
     * where an image was expected.
     *
     * It exists because the bytes die with the page. After a refresh the
     * screens can still SHOW the face — which is all they need it for — while
     * the submit correctly still waits on a real capture.
     */
    storedFaceSrc: string | null;
    idDocument: IDDocument | null;
    matchResult: MatchResult | null;
    selfieCapture: string | null;
    setSelfieCapture: (data: string | null) => void;
    goTo: (step: VerificationStep, dir?: 1 | -1) => void;
    markCompleted: (step: VerificationStep) => void;
    incrementAttempt: (step: string) => number;
    getAttemptCount: (step: string) => number;
    setLivenessResult: (result: LivenessResult | null) => void;
    setIdDocument: (doc: IDDocument | null) => void;
    setMatchResult: (result: MatchResult | null) => void;
    kycSessionId: string | null;
    setKycSessionId: (id: string | null) => void;
    resetSession: () => void;
}

const VerificationContext = createContext<VerificationContextType | undefined>(undefined);

const MAX_ATTEMPTS = 10;

export function VerificationProvider({
    children,
    initialStep = 'intro',
    hasStoredFace = false,
}: {
    children: React.ReactNode;
    /**
     * Where the flow opens. Every-login sign-in starts at 'face-reverify';
     * first-login enrolment starts at 'intro'. The caller decides, because only
     * the server knows whether this admin is already enrolled.
     */
    initialStep?: VerificationStep;
    /**
     * Whether the backend is holding a face from earlier in this sign-in
     * (`face_capture_url` on the challenge). A boolean, not the URL: the URL is
     * the backend's and stays server-side — the page only has to say whether
     * there is one to fetch.
     */
    hasStoredFace?: boolean;
}) {
    const [currentStep, setCurrentStep] = useState<VerificationStep>(initialStep);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [completedSteps, setCompletedSteps] = useState<Set<VerificationStep>>(new Set());
    const [attemptCounts, setAttemptCounts] = useState<Record<string, number>>({});
    const [livenessResult, setLivenessResult] = useState<LivenessResult | null>(null);
    const storedFaceSrc = hasStoredFace ? '/api/face-capture' : null;
    const [idDocument, setIdDocument] = useState<IDDocument | null>(null);
    const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
    const [selfieCapture, setSelfieCapture] = useState<string | null>(null);
    const [kycSessionId, setKycSessionId] = useState<string | null>(null);

    // T037: Resume from last incomplete step on mount.
    // KYC completes at 'face-match'; the video interview step was removed.
    // 'face-detection' is deliberately absent: the face is captured once, at
    // the start of the flow, and compared straight after the ID summary. The
    // step and its screen still exist — they are just not on the path, and
    // leaving it here would let the resume effect below send somebody to a
    // capture the flow no longer asks for.
    const STEP_ORDER: VerificationStep[] = [
        'intro',
        'id-capture-front',
        'id-capture-back',
        'id-summary',
        'face-match',
        'success',
    ];

    useEffect(() => {
        console.log('attemptCounts', attemptCounts);
    }, [attemptCounts]);

    useEffect(() => {
        if (completedSteps.size === 0) return;
        const firstIncomplete = STEP_ORDER.find((s) => !completedSteps.has(s));
        if (firstIncomplete && firstIncomplete !== 'intro' && firstIncomplete !== currentStep) {
            setCurrentStep(firstIncomplete);
        }
    }, []); // Only on mount

    /**
     * Follow `initialStep` when the CALLER changes it.
     *
     * The server can move this flow forward while the tree stays mounted: a
     * passed face check redirects to the same route, which re-renders with the
     * next stage and therefore a new `initialStep`. A `useState` initialiser
     * only runs on mount, so without this the provider keeps rendering the step
     * it opened with — the symptom being a face check that stays on screen
     * after it has already passed.
     *
     * Remounting the provider on a changed `key` would also work, and is what
     * this used to rely on. It cannot be used here: a remount clears
     * `livenessResult`, and that frame is the captured face the ID is compared
     * against later in enrolment. Losing it costs a second capture nobody asked
     * for — exactly what STAGE_ROUTES keeps three stages on one route to avoid.
     *
     * The ref skips the mount pass so this never overrides the resume effect
     * above; it fires only on a genuine change.
     */
    const openedAt = useRef(initialStep);
    useEffect(() => {
        if (initialStep === openedAt.current) return;
        openedAt.current = initialStep;
        setDirection(1);
        setCurrentStep(initialStep);
    }, [initialStep]);

    const goTo = useCallback((step: VerificationStep, dir: 1 | -1 = 1) => {
        setDirection(dir);
        setCurrentStep(step);
    }, []);

    const markCompleted = useCallback((step: VerificationStep) => {
        setCompletedSteps((prev) => new Set(prev).add(step));
    }, []);

    const incrementAttempt = useCallback(
        (step: string): number => {
            let newCount = 0;
            setAttemptCounts((prev) => {
                newCount = (prev[step] || 0) + 1;
                return { ...prev, [step]: newCount };
            });
            return (attemptCounts[step] || 0) + 1;
        },
        [attemptCounts],
    );

    const getAttemptCount = useCallback(
        (step: string): number => {
            return attemptCounts[step] || 0;
        },
        [attemptCounts],
    );

    const resetSession = useCallback(() => {
        setCurrentStep('intro');
        setDirection(1);
        setCompletedSteps(new Set());
        setAttemptCounts({});
        setLivenessResult(null);
        setIdDocument(null);
        setMatchResult(null);
        setSelfieCapture(null);
        setKycSessionId(null);
    }, []);

    return (
        <VerificationContext.Provider
            value={{
                currentStep,
                direction,
                completedSteps,
                attemptCounts,
                livenessResult,
                storedFaceSrc,
                idDocument,
                matchResult,
                goTo,
                markCompleted,
                incrementAttempt,
                getAttemptCount,
                setLivenessResult,
                setIdDocument,
                setMatchResult,
                kycSessionId,
                setKycSessionId,
                resetSession,
                selfieCapture,
                setSelfieCapture,
            }}
        >
            {children}
        </VerificationContext.Provider>
    );
}

export function useVerification() {
    const context = useContext(VerificationContext);
    if (!context) {
        throw new Error('useVerification must be used within a VerificationProvider');
    }
    return context;
}

export { MAX_ATTEMPTS };

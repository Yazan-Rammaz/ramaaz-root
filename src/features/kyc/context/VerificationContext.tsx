'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
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
}: {
    children: React.ReactNode;
    /**
     * Where the flow opens. Every-login sign-in starts at 'face-reverify';
     * first-login enrolment starts at 'intro'. The caller decides, because only
     * the server knows whether this admin is already enrolled.
     */
    initialStep?: VerificationStep;
}) {
    const [currentStep, setCurrentStep] = useState<VerificationStep>(initialStep);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [completedSteps, setCompletedSteps] = useState<Set<VerificationStep>>(new Set());
    const [attemptCounts, setAttemptCounts] = useState<Record<string, number>>({});
    const [livenessResult, setLivenessResult] = useState<LivenessResult | null>(null);
    const [idDocument, setIdDocument] = useState<IDDocument | null>(null);
    const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
    const [selfieCapture, setSelfieCapture] = useState<string | null>(null);
    const [kycSessionId, setKycSessionId] = useState<string | null>(null);

    // T037: Resume from last incomplete step on mount.
    // KYC completes at 'face-match'; the video interview step was removed.
    const STEP_ORDER: VerificationStep[] = [
        'intro',
        'id-capture-front',
        'id-capture-back',
        'id-summary',
        'face-detection',
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

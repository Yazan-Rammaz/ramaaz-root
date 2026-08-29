'use client';

import { useEffect } from 'react';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { FIXTURE_ID_DOCUMENT, FIXTURE_LIVENESS } from './fixtures';

/**
 * Fills `VerificationContext` with the fixture face and document, so the screens
 * that read them render with content instead of em-dashes.
 *
 * Renders nothing, and only exists inside the gallery — `VerificationProvider`
 * takes no seed props, and giving it some would be production API added for a
 * dev tool. Doing it from outside keeps the provider untouched.
 *
 * The write happens in a frame callback rather than the effect body: setting
 * state synchronously there cascades a render, which this project's
 * `react-hooks/set-state-in-effect` rule rejects (SplashGate does the same).
 */
export function SeedVerification() {
    const { setLivenessResult, setIdDocument } = useVerification();

    useEffect(() => {
        const raf = requestAnimationFrame(() => {
            setLivenessResult(FIXTURE_LIVENESS);
            setIdDocument(FIXTURE_ID_DOCUMENT);
        });
        return () => cancelAnimationFrame(raf);
    }, [setIdDocument, setLivenessResult]);

    return null;
}

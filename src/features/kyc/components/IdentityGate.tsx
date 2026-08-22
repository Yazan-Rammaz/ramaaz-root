'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { VerificationProvider } from '@/features/kyc/context/VerificationContext';
import { KycSessionProvider, type KycUser } from '@/features/kyc/context/KycSessionContext';
import VerificationPage from './VerificationPage';

/**
 * Client shell for the identity step of the login flow.
 *
 * Owns the one decision the flow machine can't make for itself: what happens
 * after the face check passes. An admin who still needs to enrol continues into
 * the ID steps; an enrolled admin is done and enters the dashboard.
 *
 *     needsEnrollment  false → face-reverify → dashboard
 *     needsEnrollment  true  → face-reverify → intro → ID → summary
 *                                            → liveness → match → success
 */
export function IdentityGate({
    user,
    challengeId,
    needsEnrollment,
}: {
    user: KycUser;
    /** Server-issued id binding the face check to this login attempt. */
    challengeId: string;
    /** True when this admin has never completed ID enrolment. */
    needsEnrollment: boolean;
}) {
    const router = useRouter();
    const [enrolling, setEnrolling] = useState(false);

    const handleReverified = useCallback(
        (stepToken: string) => {
            if (needsEnrollment) {
                // Enrolment continues in the same mounted flow; remounting with
                // a new initial step is what moves it off the face check.
                setEnrolling(true);
                return;
            }

            // TODO(kyc-api): exchange `stepToken` for the session via a Server
            // Action, then land on the dashboard. Until the backend issues real
            // tokens this just completes the flow — see SCENARIOS.md §1.
            void stepToken;
            router.replace('/dashboard');
        },
        [needsEnrollment, router],
    );

    return (
        <KycSessionProvider initialUser={user}>
            <VerificationProvider
                key={enrolling ? 'enroll' : 'reverify'}
                initialStep={enrolling ? 'intro' : 'face-reverify'}
            >
                <VerificationPage challengeId={challengeId} onReverified={handleReverified} />
            </VerificationProvider>
        </KycSessionProvider>
    );
}

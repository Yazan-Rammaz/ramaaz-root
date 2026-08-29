'use client';

import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useKycSession } from '@/features/kyc/context/KycSessionContext';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Enrolment complete.
 *
 * ── It does not navigate ────────────────────────────────────────────────────
 * The previous version pushed to `/home` on a timer AND on click, and also
 * wrote the name read off the ID onto the signed-in profile. Neither belongs
 * here now:
 *
 *  - Where sign-in goes next is the SERVER's decision. It answers the last step
 *    with a stage — `DEVICE_REQUIRED`, or `COMPLETED` with tokens — and
 *    `applyStage()` routes on that. A client-side `router.push` here would race
 *    that redirect and could land somebody on the dashboard before the backend
 *    considered them signed in.
 *  - Overwriting the account's name with OCR text off a scanned card is wrong
 *    even when it is the same person: these administrators are pre-provisioned
 *    with a name that is already authoritative.
 *
 * So this screen shows the outcome and stops. `markCompleted` tells the flow
 * machine the step is done; the redirect arrives from the action that submitted
 * it.
 */
export default function SuccessScreen() {
    const { markCompleted } = useVerification();
    const { userData } = useKycSession();

    const fullName = [userData?.user?.firstName, userData?.user?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

    useEffect(() => {
        markCompleted('success');
    }, [markCompleted]);

    return (
        <div className="flex h-full flex-col items-center justify-center px-24">
            <h1 className="fz-30 text-center leading-none font-bold text-[#1D1D1D]">
                Success Verification !
            </h1>

            <p
                className="fz-14 text-center leading-none font-normal text-[#707070]"
                style={{ marginTop: rem(12) }}
            >
                You Have Enjoy With Our Full Access
            </p>

            <div style={{ marginTop: rem(32) }}>
                <Icon name="kyc/verified" width={150} height={150} alt="" />
            </div>

            {/* Absent until the backend returns it on the face-check response —
                better a clean gap than a placeholder that is not this person. */}
            {fullName ? (
                <p
                    className="fz-14 text-center leading-none font-normal text-[#1D1D1D]"
                    style={{ marginTop: rem(24) }}
                >
                    {fullName}
                </p>
            ) : null}
        </div>
    );
}

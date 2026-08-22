'use client';

import React, { useEffect } from 'react';
import Image from 'next/image';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useKycSession } from '@/features/kyc/context/KycSessionContext';
import { useRouter } from 'next/navigation';
import { api } from '@/features/kyc/services/kycApi';
import { KycVerificationStatus } from '@/features/kyc/types/verification';
import verifiedBigSvg from '@/features/kyc/assets/verified-big.svg';

export default function SuccessScreen() {
    const { markCompleted, idDocument } = useVerification();
    const { userData, refreshUser, updateUser } = useKycSession();
    const router = useRouter();

    // Show the verified person's name — `idDocument.name` (e.g. "DANI MANSOUR"),
    // NOT `idDocument.idName` (the document-type label "Passport"). Fall back to the
    // account name, never to a placeholder unless truly empty.
    const userName =
        idDocument?.name ||
        [userData?.user?.firstName, userData?.user?.lastName].filter(Boolean).join(' ') ||
        'RDB User';

    useEffect(() => {
        markCompleted('success');
    }, [markCompleted]);

    // After verification: (1) if the account has no name yet, persist the verified
    // ID name so profile/settings/passcode/client screens stop showing "_", the raw
    // userId, or "User"; (2) refresh the profile so the verification badge flips from
    // gray to verified immediately — without a manual page reload.
    useEffect(() => {
        let cancelled = false;
        let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
        (async () => {
            // Without a loaded profile we can't safely optimistic-update — just pull it.
            if (!userData?.user) {
                await refreshUser();
                return;
            }

            const verifiedName = idDocument?.name?.trim();
            const hasAccountName = !!(userData.user.firstName || userData.user.lastName);

            // Persist the verified name to the account, but only when it's genuinely
            // nameless — never overwrite an existing chosen name.
            let firstName = userData.user.firstName;
            let lastName = userData.user.lastName;
            if (verifiedName && !hasAccountName) {
                const parts = verifiedName.split(/\s+/);
                firstName = parts[0] ?? '';
                lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
                // Non-fatal: the optimistic update + reconcile below still apply.
                // api calls never throw, so the failure shows up as !ok rather
                // than needing a try/catch. Worth logging — this used to fail
                // silently in production and the verified name never reached the
                // backend while the UI showed it as saved.
                const res = await api.profile.update(
                    lastName ? { firstName, lastName } : { firstName },
                );
                if (!res.ok) {
                    console.warn('[SuccessScreen] name write failed:', res.error.message);
                }
            }
            if (cancelled) return;

            // Optimistically reflect the verified name + status in-memory so the
            // settings/profile/passcode screens update IMMEDIATELY. NestJS /users/me
            // lags a beat behind the KYC approval + name write — that delay is exactly
            // why those screens otherwise show "_" / "User" / a gray badge until reload.
            await updateUser({
                ...userData.user,
                firstName,
                lastName,
                kycVerification: {
                    ...userData.user.kycVerification,
                    status: KycVerificationStatus.VERIFIED,
                },
            });

            // Reconcile with the server once it has caught up. Delayed so a
            // momentarily-stale /users/me can't blank the values we just set.
            reconcileTimer = setTimeout(() => {
                if (!cancelled) void refreshUser();
            }, 3000);
        })();
        return () => {
            cancelled = true;
            if (reconcileTimer) clearTimeout(reconcileTimer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            router.push('/home');
        }, 5000);

        return () => clearTimeout(timer);
    }, [router]);

    return (
        <div
            className="flex flex-col h-full bg-white items-center justify-center px-24 py-32 cursor-pointer"
            onClick={() => router.push('/home')}
        >
            <h1 className="fz-30 font-bold text-center text-[#1D1D1D]">
                Success Verification !
            </h1>
            <p className="fz-16 font-medium text-center text-[#1D1D1D] mb-33 mt-11">
                You Have Enjoy With Our Full Access
            </p>

            {/* Blue rosette verification badge */}
            <div className="mb-20">
                <Image
                    src={verifiedBigSvg}
                    alt="verified"
                    className="object-contain w-150 h-150"
                />
            </div>

            <p className="fz-18 font-medium text-[#1D1D1D]">{userName || 'RDB User'}</p>
        </div>
    );
}

'use client';

import React, { createContext, useCallback, useContext, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KycVerificationStatus } from '@/features/kyc/types/verification';

/**
 * Replaces rdb's `useAuth()` for this feature.
 *
 * rdb held the signed-in user in a client-side AuthContext. This project keeps
 * the session server-side on purpose — `getSession()` in `lib/auth/session.ts`
 * is `server-only` and hits the backend's `/auth/me`. So the session is read on
 * the server and handed down here as `initialUser`, and the screens read it
 * from context exactly as they did before.
 *
 * The shape mirrors what the ported screens destructure (`userData.user`), so
 * IntroScreen and SuccessScreen did not have to be rewritten around it.
 */

export type KycUser = {
    id: string;
    firstName: string;
    lastName: string;
    /** Present once the backend grows a KYC concept — see SCENARIOS.md. */
    kycVerification?: { status?: KycVerificationStatus | string };
};

type KycSessionValue = {
    userData: { user: KycUser } | null;
    /** Re-read the session from the server. */
    refreshUser: () => Promise<void>;
    /** Optimistic, in-memory only — see the warning below. */
    updateUser: (user: KycUser) => Promise<void>;
};

const KycSessionContext = createContext<KycSessionValue | undefined>(undefined);

export function KycSessionProvider({
    initialUser,
    children,
}: {
    initialUser: KycUser | null;
    children: React.ReactNode;
}) {
    const [user, setUser] = useState<KycUser | null>(initialUser);
    const router = useRouter();

    // The server component above us re-reads the session, so a refresh is just
    // a re-render request rather than a client-side fetch of /auth/me.
    const refreshUser = useCallback(async () => {
        router.refresh();
    }, [router]);

    /**
     * IN-MEMORY ONLY — this deliberately does NOT write to the backend.
     *
     * In rdb this persisted the name read off the ID onto the signed-in
     * profile, which was right there: the person holding the ID *was* the
     * signed-in user and their account might have had no name yet.
     *
     * Here admins are pre-provisioned with a name that is already
     * authoritative, so overwriting it with OCR text off a scanned card would
     * be wrong even though it is the same person. The useful operation is the
     * opposite — COMPARE the ID name against the provisioned one and surface a
     * mismatch. That comparison needs a backend decision, so it is pending
     * (SCENARIOS.md §3); until then this keeps the UI consistent within the
     * session and writes nothing.
     */
    const updateUser = useCallback(async (next: KycUser) => {
        setUser(next);
    }, []);

    return (
        <KycSessionContext.Provider
            value={{ userData: user ? { user } : null, refreshUser, updateUser }}
        >
            {children}
        </KycSessionContext.Provider>
    );
}

export function useKycSession(): KycSessionValue {
    const context = useContext(KycSessionContext);
    if (!context) {
        throw new Error('useKycSession must be used within a KycSessionProvider');
    }
    return context;
}

import type { ReactNode } from 'react';

import { Screen } from '@/components/ui/Screen';
import { AddActionProvider } from '@/features/shell/add-action';
import { Sidebar } from '@/features/shell/components/Sidebar';
import { Navbar } from '@/features/shell/components/Navbar';
import { Icon } from '@/components/ui/Icon';

import { PrivateCodeScreen } from '@/features/auth/components/PrivateCodeScreen';
import { DeviceStep } from '@/features/auth/components/DeviceStep';
import { IdentityGate } from '@/features/kyc/components/IdentityGate';

import { KycSessionProvider } from '@/features/kyc/context/KycSessionContext';
import { VerificationProvider } from '@/features/kyc/context/VerificationContext';
import type { VerificationStep } from '@/features/kyc/types/verification';
import VerificationPage from '@/features/kyc/components/VerificationPage';

import { SystemList } from '@/features/system/components/SystemList';
import { FaceLivenessScreen } from '@/features/kyc/components/screens/FaceLivenessScreen';

// The real route components. These have no guards of their own — the session
// gate lives in the (dashboard) layout, and `no-access` / `forbidden` are
// reachable by anyone — so they can be rendered here as-is. That is the point:
// the gallery shows the actual pages, not copies that drift from them.
import NoAccessPage from '@/app/(auth)/no-access/page';
import ForbiddenPage from '@/app/forbidden/page';
import DashboardPage from '@/app/(dashboard)/dashboard/page';
import RegionsPage from '@/app/(dashboard)/regions/page';
import CurrenciesPage from '@/app/(dashboard)/currencies/page';
import LanguagesPage from '@/app/(dashboard)/languages/page';

import { SeedVerification } from './SeedVerification';
import { FIXTURE_KYC_USER, FIXTURE_SYSTEMS } from './fixtures';

/**
 * How each catalog entry is mounted. Server-side, one function per slug.
 *
 * ── Three shells, matching the three the app has ────────────────────────────
 * A screen checked outside its shell is a screen checked at the wrong offsets,
 * so each wrapper below reproduces the layout the route would have rendered
 * inside — minus the guard that makes the route unreachable.
 */

/** The `(auth)` layout: full-bleed with the brand mark pinned top-start. */
function AuthShell({ children }: { children: ReactNode }) {
    return (
        // `h-full` mirrors the real (auth) layout — see the note there on why
        // `h-screen` is wrong on iOS.
        <div className="relative h-full overflow-hidden">
            <div className="absolute top-30 start-30">
                <Icon name="auth/rdb" width={72} height={52} alt="Ramaaz Digital Banking" />
                <p className="text-[#388CFF] text-center mt-4 font-medium">Root</p>
            </div>
            {children}
        </div>
    );
}

/**
 * The `(dashboard)` layout without `requireSession()`. Everything else — the
 * rail, the navbar, the scroll region — is the same tree the real layout builds,
 * from the same components.
 */
function DashboardShell({ children }: { children: ReactNode }) {
    return (
        <AddActionProvider>
            <div className="flex h-full w-full overflow-hidden">
                <Sidebar />
                <div className="flex min-w-0 flex-1 flex-col">
                    <Navbar />
                    <main className="thin-scroll relative min-h-0 flex-1 overflow-auto">
                        {children}
                    </main>
                </div>
            </div>
        </AddActionProvider>
    );
}

/**
 * One KYC step, mounted in the providers `IdentityGate` gives it.
 *
 * `VerificationPage` renders whichever step the context is on, so opening the
 * provider at a given `initialStep` is all it takes to land on that screen — and
 * because the screens still navigate each other, you can walk forward from
 * wherever you started.
 *
 * The submit handlers are deliberately absent: with none passed, a capture goes
 * nowhere instead of posting a fixture face to the KYC Worker.
 */
function KycStep({ step }: { step: VerificationStep }) {
    return (
        // AuthShell, because the real ones have it. Every KYC step is served
        // from /login/identity, which lives in the (auth) route group and is
        // therefore wrapped by that group's layout — the positioned container
        // and the rdb brand mark over it. The gallery skipped straight to
        // <Screen>, so it was showing these screens in a shell they never
        // actually render in: the same markup, one wrapper short.
        <AuthShell>
            <Screen variant="centered" maxW={430} gutter={0} className="h-full">
                <KycSessionProvider initialUser={FIXTURE_KYC_USER}>
                    <VerificationProvider initialStep={step}>
                        <SeedVerification />
                        <VerificationPage />
                    </VerificationProvider>
                </KycSessionProvider>
            </Screen>
        </AuthShell>
    );
}

export const SCREENS: Record<string, () => ReactNode> = {
    // ── Sign-in ─────────────────────────────────────────────────────────────
    login: () => (
        <AuthShell>
            <PrivateCodeScreen />
        </AuthShell>
    ),
    device: () => (
        <AuthShell>
            <DeviceStep />
        </AuthShell>
    ),
    'no-access': () => (
        <AuthShell>
            <NoAccessPage />
        </AuthShell>
    ),
    forbidden: () => <ForbiddenPage />,

    // ── Identity (KYC) ──────────────────────────────────────────────────────
    'kyc-face-scan': () => <KycStep step="face-reverify" />,

    // The AWS replacement for the screen above. Rendered directly rather than
    // through VerificationPage, because it is not a step in that state machine
    // yet — the point of this entry is to judge whether it should become one.
    //
    // ⚠️ It talks to the REAL Rekognition, and the challenge id below is a
    // placeholder — so /reverify/start refuses it and this shows the failure
    // state, not the oval. The oval needs a live sign-in; this entry exists so
    // the chrome, the title block and the failure copy can be checked at all.
    'kyc-face-liveness': () => (
        <AuthShell>
            <Screen variant="centered" maxW={430} gutter={0} className="h-full">
                <FaceLivenessScreen
                    challengeId="design-preview"
                    // Never reached without a valid challenge; present because
                    // the prop is required, and required because in the real
                    // flow a session with nowhere to go is a bug.
                    onSession={async () => ({ error: 'Design gallery — no live challenge.' })}
                />
            </Screen>
        </AuthShell>
    ),
    'kyc-intro': () => <KycStep step="intro" />,
    'kyc-id-front': () => <KycStep step="id-capture-front" />,
    'kyc-id-back': () => <KycStep step="id-capture-back" />,
    'kyc-id-summary': () => <KycStep step="id-summary" />,
    'kyc-face-match': () => <KycStep step="face-match" />,
    'kyc-success': () => <KycStep step="success" />,
    'kyc-contact-support': () => <KycStep step="contact-support" />,
    'kyc-liveness': () => <KycStep step="face-detection" />,

    // The flow as one mounted tree, the way a real sign-in runs it. No handlers
    // are passed, so each step reports "passed" locally and moves on without
    // anything leaving the browser.
    'identity-flow': () => (
        // Same shell as the route this mirrors — /login/identity, inside (auth).
        <AuthShell>
            <Screen variant="centered" maxW={430} gutter={0} className="h-full">
                <IdentityGate needsEnrollment={false} />
            </Screen>
        </AuthShell>
    ),

    // ── Dashboard ───────────────────────────────────────────────────────────
    dashboard: () => (
        <DashboardShell>
            <DashboardPage />
        </DashboardShell>
    ),
    // Not the real page: `listSystems()` reads the registry that lived in the
    // deleted root-backend, so it throws rather than returning rows. The list
    // component itself IS the real one.
    systems: () => (
        <DashboardShell>
            <SystemList items={FIXTURE_SYSTEMS} selectedId="rdb" />
        </DashboardShell>
    ),
    regions: () => (
        <DashboardShell>
            <RegionsPage />
        </DashboardShell>
    ),
    currencies: () => (
        <DashboardShell>
            <CurrenciesPage />
        </DashboardShell>
    ),
    languages: () => (
        <DashboardShell>
            <LanguagesPage />
        </DashboardShell>
    ),
};

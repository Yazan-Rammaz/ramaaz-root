'use client';

import { useCallback, useEffect, useState } from 'react';
import { VerificationProvider } from '@/features/kyc/context/VerificationContext';
import { KycSessionProvider } from '@/features/kyc/context/KycSessionContext';
import VerificationPage from './VerificationPage';
import type { EnrolmentInput } from './screens/FaceMatchScreen';

/**
 * Client shell for the identity flow.
 *
 *     needsEnrollment  false → face check → the server decides what follows
 *     needsEnrollment  true  → face check → intro → ID → summary → match → done
 *
 * ── One mount, start to finish ──────────────────────────────────────────────
 * Enrolment continues in the SAME mounted tree the face check ran in. That is
 * deliberate and load-bearing: the captured frame lives in `VerificationContext`
 * and is reused when the ID is compared against it, so unmounting between steps
 * would drop it and force a second capture. Moving between steps is a state
 * change here, never a navigation.
 *
 * ── It does not decide where to go next ─────────────────────────────────────
 * There is no `router.push` in this component. Each step posts its result
 * through a Server Action, the server answers with the next stage, and
 * `applyStage()` performs the redirect. A client-side push would race that and
 * could land somebody past a step the backend had not accepted.
 */

/**
 * How long a passed face check stays on screen before the flow moves on —
 * long enough for the green frame to register as an answer.
 *
 * ⚠️ This only governs the stages that share THIS route (face → ID enrolment).
 * A returning admin goes to DEVICE_REQUIRED instead, and that redirect is a
 * real navigation performed by the server action: it unmounts this tree the
 * moment it lands, so the green frame flashes rather than holds. Making that
 * case wait would mean delaying the redirect itself, which is the server's
 * call and not worth taking from it for two seconds of feedback.
 */
const SUCCESS_HOLD_MS = 2000;
export function IdentityGate({
    needsEnrollment,
    onCapture,
    onEnroll,
    challengeId,
    onLivenessSession,
}: {
    /** True when this admin has never completed ID enrolment. */
    needsEnrollment: boolean;
    /** Submits the captured face to the server. See VerificationPage. */
    onCapture?: (frame: string) => Promise<{ error?: string } | void>;
    /** Submits the ID enrolment once the face has matched it. Same seam. */
    onEnroll?: (input: EnrolmentInput) => Promise<{ error?: string } | void>;
    /** The sign-in this check belongs to — see VerificationPage. */
    challengeId?: string;
    /** Submits a finished AWS liveness session — see VerificationPage. */
    onLivenessSession?: (sessionId: string) => Promise<{ error?: string } | void>;
}) {
    // ── Who moves the flow off the face check ───────────────────────────────
    // The SERVER does, and `needsEnrollment` is how it says so: a passed face
    // check redirects to this same route, which re-renders with the ID stage
    // and flips this prop to true.
    //
    // So the prop is read on every render, not captured once. It used to seed
    // `useState`, which only reads its initialiser on mount — the stage
    // advanced, the prop flipped, and nothing happened. The local fallback
    // below was supposed to cover that, but it is unreachable on the happy
    // path: `submitFaceAction` ends in `applyStage`, which redirects by
    // THROWING, so `onCapture` never returns and `onReverified` is never
    // called. Both routes out of the face check were blocked at once, and the
    // camera simply stayed on screen after a 99.9% match.
    //
    // ── And it does not advance the INSTANT the server says so ──────────────
    // A passed face check paints the frame green, and swapping the tree in the
    // same tick would replace that frame before anyone saw it — the check would
    // appear to succeed by teleporting to another screen. So a mid-flow flip is
    // held for SUCCESS_HOLD_MS. A first render that ALREADY says enrolling is
    // not held: nothing was on screen to see.
    const [advancedLocally, setAdvancedLocally] = useState(false);
    // Seeded from the prop so a first render that already says "enrolling"
    // opens immediately — there is no green frame to hold on to yet.
    const [heldOpen, setHeldOpen] = useState(needsEnrollment);

    // Either source may ask to advance; both wait out the same hold, so the
    // local fallback cannot skip the pause the server path observes.
    const wantsEnrolling = needsEnrollment || advancedLocally;
    const enrolling = wantsEnrolling && heldOpen;

    useEffect(() => {
        if (!wantsEnrolling || heldOpen) return;
        const timer = setTimeout(() => setHeldOpen(true), SUCCESS_HOLD_MS);
        return () => clearTimeout(timer);
    }, [wantsEnrolling, heldOpen]);

    const handleReverified = useCallback(() => {
        // Kept for the case where the step passes WITHOUT a redirect. The
        // server owns the ordering, so this only ever runs ahead of it.
        setAdvancedLocally(true);
    }, []);

    // No user yet: mid-challenge there is no session to read one from. The
    // backend supplies the name on the face-check response, and the screens
    // degrade to "Welcome !" until it arrives.
    return (
        <KycSessionProvider initialUser={null}>
            {/*
              * No `key` here, deliberately. Keying on `enrolling` remounted the
              * provider when the flow advanced, which cleared `livenessResult`
              * — the captured face the ID is compared against two steps later.
              * The provider follows a changed `initialStep` on its own now, so
              * the step moves and the frame survives.
              */}
            <VerificationProvider initialStep={enrolling ? 'intro' : 'face-reverify'}>
                {/* `wantsEnrolling` is the server's yes, and it arrives the
                    moment the stage flips — before `enrolling` opens, since
                    that waits out SUCCESS_HOLD_MS. That gap IS the green
                    frame: the capture screen paints the verdict during it. */}
                <VerificationPage
                    challengeId={challengeId}
                    onLivenessSession={onLivenessSession}
                    onCapture={onCapture}
                    onReverified={handleReverified}
                    faceVerified={wantsEnrolling}
                    onEnroll={onEnroll}
                />
            </VerificationProvider>
        </KycSessionProvider>
    );
}

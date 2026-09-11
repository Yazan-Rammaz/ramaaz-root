'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'motion/react';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import type { IDDocument } from '@/features/kyc/types/verification';
import { api } from '@/features/kyc/services/kycApi';
import { useRouter } from 'next/navigation';
import ExitConfirmDialog from '../ExitConfirmDialog';
import faceDetectSvg from '@/features/kyc/assets/face-detect.svg';
import liveDetectIdSvg from '@/features/kyc/assets/live-detect-id.svg';
import { FlexSpace } from '@/components/ui/FlexSpace';

type MatchState = 'matching' | 'success' | 'review' | 'failed';

/**
 * Animation timing.
 *
 * The sequence the design asks for is: show the captured face alone for a
 * beat, run the comparison against the ID, then hold the verdict long enough
 * to be read before moving on.
 *
 * `TOTAL_ANIM_MS` is the comparison itself, and it is a FLOOR rather than a
 * wait: the real AWS call usually returns sooner, and finishing the animation
 * early would show a verdict before the person had understood what was being
 * compared. The screen advances on whichever finishes last.
 */
const FACE_ONLY_MS = 2_000; // the captured face, alone, before the ID appears
const TOTAL_ANIM_MS = 4_000; // the comparison animation
const OPACITY_STEP_MS = 1_000; // each opacity transition lasts 1 sec
const FRAME_FLASHES_PER_CYCLE = 3; // flashes 3 times during each ID-visible cycle
const FRAME_FLASH_MS = 300; // each flash lasts 300 ms

/**
 * What this screen hands to whoever owns the enrolment exchange.
 *
 * Deliberately this feature's OWN vocabulary — an `IDDocument`, a selfie, two
 * numbers — and not the auth backend's `evidence` shape. The caller translates.
 * That is the same seam `onCapture` uses one screen earlier, and it exists for
 * the same reason: this component drives a camera and a comparison, and has no
 * business knowing the sign-in protocol or holding a credential. It also keeps
 * the feature portable (see PORTING.md), which it would not be if a KYC screen
 * imported a Server Action from `features/auth`.
 */
export type EnrolmentInput = {
    idDocument: IDDocument;
    /** The frame captured at the face step — never re-shot for this. */
    selfie: string;
    /** What Rekognition scored that selfie against the document photo. */
    selfieVsIdScore: number;
    livenessConfidence?: number;
};

export default function FaceMatchScreen({
    onEnroll,
}: {
    /**
     * Submits the enrolment. Returning an error shows it; returning nothing
     * means the caller took over — typically by redirecting, which is what the
     * real implementation does on its way to the device step.
     */
    onEnroll?: (input: EnrolmentInput) => Promise<{ error?: string } | void>;
} = {}) {
    const {
        goTo,
        livenessResult,
        idDocument,
        setMatchResult,
        incrementAttempt,
        resetSession,
    } = useVerification();
    const router = useRouter();

    const [matchState, setMatchState] = useState<MatchState>('matching');
    const [subtitle, setSubtitle] = useState('AI is comparing your face with your ID...');
    const [showExitDialog, setShowExitDialog] = useState(false);
    /** False for the first FACE_ONLY_MS — the face is shown on its own. */
    const [comparing, setComparing] = useState(false);
    const [animDone, setAnimDone] = useState(false);
    const [frameFlashOn, setFrameFlashOn] = useState(false);

    const apiResultRef = useRef<{
        status: 'success' | 'error';
        matchScore?: number;
        message?: string;
    } | null>(null);

    // (Removed with the session: root has no KYC session to consume. The
    // challenge carries the whole flow, and re-submitting is governed by its
    // five-attempt budget on the server — not by a client-side spent flag.)

    /** Guards `runMatch` against overlapping runs. See the note there. */
    const matchInFlight = useRef(false);
    /** The comparison currently in flight, so the finaliser can wait for it. */
    const matchPendingRef = useRef<Promise<unknown> | null>(null);

    const handleFailure = useCallback(
        (msg?: string) => {
            // NOTE: do NOT increment the attempt count here. A failed face
            // detection / compare is not a "try" — the count is bumped once per
            // actual submit (see finaliseAfterAnimation). The final block/decision
            // is owned by the NestJS backend, never the client.
            setMatchState('failed');
            setSubtitle(msg || 'ID Matching With Your Photo Not Correct');
        },
        [],
    );

    const finaliseAfterAnimation = useCallback(async () => {
        // Wait for the comparison if it has not landed yet. The animation is a
        // minimum duration for the sake of the person watching, not a deadline
        // for AWS — so a request still in flight is waited on rather than
        // written off. Only a cycle with no request at all is a real failure.
        let data = apiResultRef.current;
        if (!data && matchPendingRef.current) {
            await matchPendingRef.current;
            data = apiResultRef.current;
        }
        if (!data) {
            console.error('[FaceMatch] no compare result when the animation finished');
            handleFailure();
            return;
        }
        if (data.status === 'success') {
            const score = data.matchScore ?? 90;
            setMatchResult({
                isMatch: true,
                confidence: score / 100,
                similarity: score,
                verdict: 'pass',
                errorMessage: null,
            });
            // ⚠️ NOT done yet — and this is the whole point of the ordering.
            //
            // A passing COMPARE is not a passing ENROLMENT. The comparison here
            // runs against `passThreshold`, which is 0, so it passes on any two
            // images with a detectable face; the backend then applies the real
            // threshold and can refuse. Announcing "Done" here and printing a
            // failure a few seconds later is what that gap looked like on
            // screen. The success state is set below, after the enrolment has
            // actually been accepted — and by then the redirect to the device
            // step is usually already in flight, which is the honest signal
            // that it worked.
            if (idDocument && livenessResult?.faceImageData) {
                // ── Enrolment goes to the AUTH backend, in one call ──────────
                //
                // Not to the KYC Worker's /submit. That route is RDB's: three
                // uploads to /media/upload/direct, a country lookup against
                // /countries, then URLs posted to /kyc/submit. All three answer
                // 404 on the root backend, which never had that contract — and
                // the first symptom was this screen dying on "session start
                // failed: Unauthorized", because /session is guarded by an
                // access token that does not exist mid sign-in.
                //
                // Root's whole document step is POST /v1/auth/identity-document
                // with the images inline (root-enrollment.md §5). There is no
                // KYC session to start: the challenge carries the flow, which
                // is why nothing here fetches one.
                //
                // The action redirects on success — the backend answers
                // DEVICE_REQUIRED and applyStage() sends the browser to the
                // passkey ceremony. So there is no navigation to write here,
                // and no 'success' step on this path: the device screen IS
                // what comes next.
                incrementAttempt('face-match');

                if (!onEnroll) {
                    // No enrolment seam supplied. Loud in the console, because
                    // the alternative is a screen that looks like it verified
                    // somebody and stored nothing.
                    console.error('[FaceMatch] no onEnroll seam supplied');
                    handleFailure();
                    return;
                }

                const result = await onEnroll({
                    idDocument,
                    selfie: livenessResult.faceImageData,
                    selfieVsIdScore: score,
                    livenessConfidence: livenessResult.metrics?.confidence,
                });

                // Only reached when the caller did NOT redirect — i.e. it
                // failed.
                //
                // The backend's reason goes to the CONSOLE, never to the
                // screen. It is written for whoever is integrating — "selfie
                // below threshold", a correlation id, a validation field — and
                // on a sign-in screen it is at best noise and at worst a
                // description of how close an attacker got. One fixed line
                // here; the detail stays where it is useful.
                if (result?.error) {
                    console.error('[FaceMatch] enrolment refused:', result.error);
                    handleFailure();
                    return;
                }

                // Accepted. Usually unreachable, because the action redirects
                // to the device step by throwing — but shown when it does
                // return, so "Done" is only ever true.
                setMatchState('success');
                setSubtitle('ID Matching With Your Photo Done');
            } else {
                console.warn('[FaceMatch] Skipping submit — missing:', {
                    hasIdDocument: !!idDocument,
                    hasFace: !!livenessResult?.faceImageData,
                });

                // ⚠️ A MISSING FRAME IS NOT A FAILED MATCH, and saying so was a
                // lie the user could not argue with.
                //
                // `livenessResult` is React state holding a ~300KB data URL, so
                // a page refresh anywhere in enrolment drops it. This branch
                // then ran and the screen announced "ID Matching With Your Photo
                // Not Correct" — accusing somebody's face of not being their
                // face, when what actually happened is that we lost the
                // photograph and never compared anything at all.
                //
                // Nothing was submitted and nothing was judged, so the honest
                // message names the refresh. Recovery is still a restart: the
                // frame only exists in this tab, and re-opening the link is what
                // rebuilds the sequence. That changes when the backend stores
                // step data by token — see docs/kyc/step-restore.md — and this
                // whole branch becomes unreachable.
                handleFailure(
                    livenessResult?.faceImageData
                        ? undefined
                        : 'Your photo was lost when the page reloaded. Open your access link again to restart.',
                );
            }
        } else {
            setMatchResult({
                isMatch: false,
                confidence: 0,
                similarity: 0,
                verdict: 'fail',
                errorMessage: data.message ?? 'Face did not match',
            });
            // Same rule as above: the service's own wording goes to the
            // console, the screen gets the one fixed line.
            if (data.message) console.error('[FaceMatch] compare failed:', data.message);
            handleFailure();
        }
    }, [handleFailure, setMatchResult, goTo, incrementAttempt]);

    const runMatch = useCallback(async () => {
        // One comparison at a time.
        //
        // `reactStrictMode` double-invokes the mount effect in dev, so this
        // fired twice within the same millisecond — and each call clears
        // `apiResultRef` on entry. The second clear lands while the first
        // cycle's animation is finishing, `finaliseAfterAnimation` reads a null
        // ref, and the screen reports "Face match timed out" for a request that
        // answered in under a second. The retry button can produce the same
        // overlap with a double tap.
        if (matchInFlight.current) return;
        matchInFlight.current = true;

        setMatchState('matching');
        setSubtitle('AI is comparing your face with your ID...');
        setAnimDone(false);
        hasFinalisedRef.current = false;
        apiResultRef.current = null;

        const liveFace = livenessResult?.faceImageData ?? '';
        const idFace = idDocument?.idFaceImageData || idDocument?.frontImageData || '';

        if (!liveFace || !idFace) {
            console.error('[FaceMatch] missing face or ID image', {
                hasLiveFace: Boolean(liveFace),
                hasIdFace: Boolean(idFace),
            });
            handleFailure();
            matchInFlight.current = false;
            return;
        }

        // Fire AWS CompareFaces in parallel with the 10s animation.
        // This was a raw fetch, so an access token that expired during the
        // verification flow failed the match outright; api.kyc refreshes and
        // retries. It also never throws, so the catch is gone.
        // The request is kept as a PROMISE, not just as a result.
        //
        // The animation is a floor, not a guarantee: it can finish while this
        // call is still out — a slow network, a cold Rekognition call, a phone
        // that throttled the tab. Reading only the settled result meant
        // `finaliseAfterAnimation` saw `null` and reported the match as timed
        // out, discarding a request that then answered fine a moment later.
        // Holding the promise lets the finaliser WAIT for the answer it
        // already asked for instead of giving up on it.
        const pending = api.kyc
            .compareFace({ selfieImageData: liveFace, idFaceImageData: idFace })
            .then((res) => {
                apiResultRef.current = res.ok
                    ? res.data
                    : { status: 'error', message: res.error.message };
                return apiResultRef.current;
            })
            .finally(() => {
                matchInFlight.current = false;
            });

        matchPendingRef.current = pending;
        await pending;
    }, [livenessResult, idDocument, handleFailure]);

    useEffect(() => {
        runMatch();
    }, []);

    // Drive the comparison animation: every 2s a new cycle (1s ID visible, 1s
    // face visible). During the ID-visible second, fire 3 frame-flashes 300ms apart.
    //
    // The cycles do not begin immediately. For FACE_ONLY_MS the captured face
    // sits alone, so the person recognises themselves before anything is
    // compared against them — the ID sliding in then reads as an act rather
    // than as two images that were always on screen together.
    useEffect(() => {
        if (matchState !== 'matching') return;
        const start = Date.now();
        const openTimer = window.setTimeout(() => setComparing(true), FACE_ONLY_MS);
        const cycleMs = OPACITY_STEP_MS * 2; // 2000 ms per cycle
        const flashGap = OPACITY_STEP_MS / FRAME_FLASHES_PER_CYCLE; // ≈ 333 ms

        const flashTimers: number[] = [];
        const cycleInterval = window.setInterval(() => {
            // Schedule the 3 flashes at the start of every cycle (when ID is opaque).
            for (let i = 0; i < FRAME_FLASHES_PER_CYCLE; i++) {
                const t1 = window.setTimeout(() => setFrameFlashOn(true), i * flashGap);
                const t2 = window.setTimeout(
                    () => setFrameFlashOn(false),
                    i * flashGap + FRAME_FLASH_MS,
                );
                flashTimers.push(t1, t2);
            }
        }, cycleMs);
        // Fire the first flash burst immediately
        for (let i = 0; i < FRAME_FLASHES_PER_CYCLE; i++) {
            const t1 = window.setTimeout(() => setFrameFlashOn(true), i * flashGap);
            const t2 = window.setTimeout(
                () => setFrameFlashOn(false),
                i * flashGap + FRAME_FLASH_MS,
            );
            flashTimers.push(t1, t2);
        }

        const stopTimer = window.setTimeout(() => {
            window.clearInterval(cycleInterval);
            flashTimers.forEach(window.clearTimeout);
            setAnimDone(true);
        }, TOTAL_ANIM_MS);

        return () => {
            window.clearTimeout(openTimer);
            window.clearInterval(cycleInterval);
            window.clearTimeout(stopTimer);
            flashTimers.forEach(window.clearTimeout);
            const elapsed = Date.now() - start;
            void elapsed; // keep linter happy; useful when debugging timing
        };
    }, [matchState]);

    const hasFinalisedRef = useRef(false);
    // Once the animation completes, look at the API result and decide.
    // Guard with a ref so the effect never fires twice even if finaliseAfterAnimation
    // changes identity after the first state update (which would cause an infinite loop).
    useEffect(() => {
        if (!animDone || hasFinalisedRef.current) return;
        hasFinalisedRef.current = true;
        finaliseAfterAnimation();
    }, [animDone]); // eslint-disable-line react-hooks/exhaustive-deps

    const borderColor =
        matchState === 'success' ? '#34D317' : matchState === 'failed' ? '#FF5F61' : '#388CFF';

    const liveFace = livenessResult?.faceImageData;
    const idImage = idDocument?.frontImageData || idDocument?.idFaceImageData;

    return (
        // `overflow-y-auto` is the last resort, the same one IDSummaryScreen
        // has: if the elastic space runs out the screen scrolls rather than
        // pushing Rematch off the bottom edge. At 932 there is slack, so nothing
        // scrolls and the frame is untouched.
        <div className="thin-scroll flex min-h-0 h-full flex-col overflow-y-auto bg-white px-40">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => router.push('/home')}
            />

            {/*
              ── The comparison frame is rigid; the white space gives ─────────
              350 x 400 on every viewport. Everything on this screen carries
              `shrink-0` so a short screen cannot take its shortfall out of the
              frame — a flex item shrinks by default, and the tallest item is
              always the first thing the browser reaches for.

              The margins are split rigid + elastic for the reason spelled out
              in IDSummaryScreen: flexbox freezes whatever hits zero and re-splits
              the remainder among the survivors, so the last spacer standing
              absorbs everything and a margin meant to give a little collapses
              entirely. 56 + 44 at the top, 24 + 11 at the foot — still the 100
              and 35 the frame asks for. Shares total 1: 0.25 top, 0.65 on the
              150 above the buttons, 0.10 at the foot.
            */}
            <FlexSpace size={56} share={0} />
            <FlexSpace size={44} share={0.25} />

            <h1 className="fz-30 leading-none font-bold text-center text-[#1D1D1D] mb-5 shrink-0">
                Identity Verification !
            </h1>
            <div className="flex shrink-0 items-center justify-center gap-8 mb-11">
                <Image src={faceDetectSvg} alt="face" className="object-contain w-20 h-20" />
                <Image src={liveDetectIdSvg} alt="id" className="object-contain w-20 h-20" />
                <span className="fz-16 font-medium text-[#1D1D1D] whitespace-nowrap">
                    {subtitle}
                </span>
            </div>

            {/* Comparison stage: face (back) and ID (front, fading) on the same canvas */}
            <div
                // `shrink-0` holds this at exactly 350 x 400 everywhere. It is
                // the whole point of the screen — the user is being shown the
                // two images that were compared — so it is the one thing that
                // must not be resized to make room.
                className="relative mx-auto shrink-0 overflow-hidden rad-30 transition-colors duration-500 w-350 h-400 bg-[#E9EEEE]"
                style={{ border: `2px solid ${borderColor}` }}
            >
                {/* User face — always rendered */}
                {liveFace ? (
                    <img
                        src={liveFace}
                        alt="Face"
                        // Mirrored, for the same reason as IntroScreen and
                        // LivenessVerdict: this is the raw camera frame, and the
                        // preview it came from was `scaleX(-1)`. All three show
                        // the SAME string, so all three flip it or none do —
                        // one screen disagreeing is what made the face look
                        // reversed between steps.
                        //
                        // CSS only. `liveFace` is posted verbatim as `selfie`
                        // above; the comparison the server runs never sees this.
                        className="absolute inset-0 w-full h-full -scale-x-100 object-cover"
                        style={{ backgroundColor: '#E9EEEE' }}
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-gray-400 text-xs">Face Photo</span>
                    </div>
                )}

                {/* AI scanning line over the face — moves while matching */}
                {matchState === 'matching' && (
                    <motion.div
                        className="absolute start-0 end-0 pointer-events-none z-20"
                        style={{
                            height: '3px',
                            background:
                                'linear-gradient(90deg, transparent 0%, rgba(122,168,255,0.95) 50%, transparent 100%)',
                            boxShadow: '0 0 14px 3px rgba(122,168,255,0.7)',
                        }}
                        animate={{ top: ['0%', '100%', '0%'] }}
                        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}

                {/* ID image — crossfades over the face every cycle */}
                {idImage && matchState === 'matching' && comparing && (
                    <motion.div
                        className="absolute z-10 w-280 h-157 bottom-11 start-35"
                        animate={{ opacity: [0.5, 1, 1, 0.5, 0.5] }}
                        transition={{
                            duration: 2,
                            ease: 'easeInOut',
                            times: [0, 0.5, 0.5, 1, 1],
                            repeat: Infinity,
                        }}
                    >
                        <img
                            src={idImage}
                            alt="ID"
                            className="w-full h-full object-cover bg-[#E9EEEE]"
                        />

                        {/* Small face frame on the ID — flashes 3× during each cycle.
                            Position approximates a typical ID layout (left-third). */}
                        <AnimatePresence>
                            {frameFlashOn && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.94 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.94 }}
                                    transition={{ duration: 0.15 }}
                                    className="absolute pointer-events-none"
                                    style={{
                                        top: '22%',
                                        left: '8%',
                                        width: '28%',
                                        height: '46%',
                                        borderRadius: '6px',
                                    }}
                                >
                                    <div className="absolute inset-0 rounded-md" />
                                    {/* ID camera-style corner brackets */}
                                    <span
                                        className="absolute"
                                        style={{
                                            top: -2,
                                            left: -2,
                                            width: 14,
                                            height: 14,
                                            borderTop: '3px solid #FFD700',
                                            borderLeft: '3px solid #FFD700',
                                            borderRadius: '8px 0 0 0',
                                        }}
                                    />
                                    <span
                                        className="absolute"
                                        style={{
                                            top: -2,
                                            right: -2,
                                            width: 14,
                                            height: 14,
                                            borderTop: '3px solid #FFD700',
                                            borderRight: '3px solid #FFD700',
                                            borderRadius: '0 8px 0 0',
                                        }}
                                    />
                                    <span
                                        className="absolute"
                                        style={{
                                            bottom: -2,
                                            left: -2,
                                            width: 14,
                                            height: 14,
                                            borderBottom: '3px solid #FFD700',
                                            borderLeft: '3px solid #FFD700',
                                            borderRadius: '0 0 0 8px',
                                        }}
                                    />
                                    <span
                                        className="absolute"
                                        style={{
                                            right: -2,
                                            bottom: -2,
                                            width: 14,
                                            height: 14,
                                            borderRight: '3px solid #FFD700',
                                            borderBottom: '3px solid #FFD700',
                                            borderRadius: '0 0 8px 0',
                                        }}
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )}
            </div>

            {matchState === 'review' && (
                <div className="mt-20 mx-auto max-w-300 rounded-xl border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-16 py-12 text-center">
                    <p className="text-xs text-center font-medium text-[#92400E]">
                        Match accepted with low confidence — your verification will be reviewed by
                        our team. Continuing to the next step…
                    </p>
                </div>
            )}
            {matchState === 'failed' && (
                <p className="fz-14 shrink-0 text-center text-[#1D1D1D] mt-12 mb-20">
                    We noticed a discrepancy in the image and there is an issue with your
                    verification.
                </p>
            )}

            <FlexSpace size={150} share={0.75} />

            {matchState === 'failed' && (
                // The stray `flex-1` that used to open this block is gone: a
                // growing spacer inside a `mt-auto` block fights the very
                // alignment that block exists to do.
                <div className="mt-auto flex shrink-0 items-center flex-col justify-end">
                    <button
                        onClick={() => {
                            resetSession();
                            goTo('intro', -1);
                        }}
                        // mb-12 — the flow-wide gap between a button and the
                        // text link under it. The pair is one control with a
                        // secondary way out, not two sections.
                        className="mb-12 w-390 h-60 py-16 rad-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] fz-16 font-medium"
                    >
                        Try Again With The Correction
                    </button>
                    <button
                        onClick={() => runMatch()}
                        className="fz-14 text-[#4D84FF] hover:underline"
                    >
                        Rematch
                    </button>
                </div>
            )}
            {/* 12 from the foot, STATIC — the flow-wide rule. */}
            <FlexSpace size={12} share={0} />
        </div>
    );
}

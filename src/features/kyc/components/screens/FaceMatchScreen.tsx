'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import type { IDDocument } from '@/features/kyc/types/verification';
import { api } from '@/features/kyc/services/kycApi';
import { useRouter } from 'next/navigation';
import ExitConfirmDialog from '../ExitConfirmDialog';
import { FlexSpace } from '@/components/ui/FlexSpace';
import { fetchStoredFace } from '@/features/kyc/services/storedFace';
import { useFacePhoto } from '@/features/kyc/hooks/useFacePhoto';
import { PhotoGlass } from '@/features/kyc/components/PhotoGlass';
import { SparkField } from '@/features/kyc/components/SparkField';
import { MatchCelebration } from '@/features/kyc/components/MatchCelebration';
import { MIRROR_CLASS } from '@/features/kyc/config/capture';
import { Icon } from '@/components/ui/Icon';

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
 * How long the screen is held after the enrolment is accepted, before the
 * sign-in moves on to the dashboard.
 *
 * ⚠️ IT DELAYS A REDIRECT, so it is a real cost paid by somebody who has just
 * finished and wants to be in. Three seconds is the length of the celebration
 * itself — the wash, its wake and the burst all land inside it (see
 * `match-wash` / `match-burst` in globals.css) — and nothing waits on this but
 * the animation. Shorten it and the wake is cut off mid-way; lengthen it and
 * the screen is holding a finished person on a finished screen.
 */
const CELEBRATION_MS = 3_000;

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
    /**
     * Called the moment the enrolment is ACCEPTED and before the sign-in moves
     * on. Awaited — whatever it returns is held for.
     *
     * ── Why the screen cannot simply do this itself ─────────────────────────
     * Because it never gets the chance. Acceptance and navigation are the same
     * event from here: the final Server Action calls `redirect()`, so the
     * router leaves this route as part of the response and the success branch
     * below is, by its own comment, "usually unreachable". There is no moment
     * on this side of `onEnroll` in which the answer is known and the screen
     * still exists.
     *
     * So the pause is opened from the inside. The implementation calls this
     * after the Worker has passed the document and signed for it, and waits on
     * it before the exchange that redirects — which is the one place where the
     * result is certain and the screen is still mounted.
     *
     * ⚠️ AFTER ACCEPTANCE, NEVER AFTER THE COMPARISON. The comparison runs at a
     * threshold of zero and passes on any two faces; the real one is applied
     * afterwards. A celebration hung on the compare would announce a result the
     * next call can still refuse, which is the exact failure the ordering in
     * `finaliseAfterAnimation` was written to avoid.
     */
    onAccepted?: () => Promise<void> | void;
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
        resetSession,
        storedFaceSrc,
    } = useVerification();
    const router = useRouter();

    const t = useTranslations('auth');
    const [matchState, setMatchState] = useState<MatchState>('matching');
    /**
     * The three-second send-off. Set from inside the enrolment — see
     * `onAccepted` — and never cleared: the next thing that happens is the
     * redirect, and unmounting the celebration before then would leave a blank
     * green-bordered frame for the last moment of the sign-in.
     */
    const [celebrating, setCelebrating] = useState(false);
    /**
     * A message the SERVER sent, shown instead of our own line when there is
     * one.
     *
     * Deliberately not translated: it arrives as text, in whatever language the
     * backend speaks, and inventing a key for a sentence we did not write would
     * mean showing something other than what it said.
     */
    const [serverMessage, setServerMessage] = useState<string | null>(null);
    /*
     * The subtitle as a message KEY, not a sentence.
     *
     * It used to hold the English text itself, which meant a language change
     * mid-screen left the previous locale's copy on screen until something
     * happened to overwrite it — state does not re-render through `t`. Holding
     * the key and resolving it below fixes that for free.
     */
    const [subtitleKey, setSubtitleKey] = useState<'matchComparing' | 'matchDone' | 'matchWrong'>(
        'matchComparing',
    );
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
    /**
     * The captured face `runMatch` actually used — from memory, or refetched
     * from the backend after a reload.
     *
     * The enrolment below needs the SAME image the comparison ran on, and after
     * a refresh that is not `livenessResult`, which is gone. A ref because it is
     * resolved inside an async run and nothing renders from it.
     */
    const resolvedFaceRef = useRef<string | null>(null);

    const handleFailure = useCallback((msg?: string) => {
        // NOTE: do NOT increment the attempt count here. A failed face
        // detection / compare is not a "try" — the count is bumped once per
        // actual submit (see finaliseAfterAnimation). The final block/decision
        // is owned by the NestJS backend, never the client.
        setMatchState('failed');
        // The server's own words when it gave any, otherwise ours. Its
        // message is not translated — it is a backend string — so it is shown
        // as sent rather than guessed at.
        setServerMessage(msg ?? null);
        setSubtitleKey('matchWrong');
    }, []);

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
            // The face the comparison ran on — which after a reload is the
            // refetched copy, not `livenessResult`. Reading state here is what
            // made a reloaded page skip the submit and report a mismatch.
            const selfie = livenessResult?.faceImageData ?? resolvedFaceRef.current;

            if (idDocument && selfie) {
                // ── Two calls, and no KYC session ────────────────────────────
                //
                // The images go to the WORKER, which analyses them and commits
                // what it measured to POST /v1/kyc/submit over a signed
                // channel; the backend decides and mints a single-use
                // stepToken, and only THAT is posted to
                // /v1/auth/identity-document. The images never reach the auth
                // path — posting them there now answers 422.
                //
                // What this is NOT is RDB's flow: three uploads to
                // /media/upload/direct, a country lookup against /countries,
                // then URLs posted to /kyc/submit. All of those 404 here, and
                // the first symptom was this screen dying on "session start
                // failed: Unauthorized", because /session is guarded by an
                // access token that does not exist mid sign-in.
                //
                // There is no KYC session to start at all: the challenge
                // carries the flow, which is why nothing here fetches one.
                // See `backend docs/root-enrollment.md` §5.
                //
                // The action redirects on success — applyStage() routes on
                // whatever stage the backend named, so there is no navigation
                // to write here and no 'success' step on this path.
                //
                // With device verification off that answer is COMPLETED with
                // the tokens, and the administrator lands in the dashboard.
                // It used to be DEVICE_REQUIRED and the passkey screen. Which
                // one arrives is the server's business, not this screen's —
                // do not hard-code either.
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
                    selfie,
                    selfieVsIdScore: score,
                    /*
                     * Accepted — hold the screen for three seconds and say so.
                     *
                     * This is the only point in the flow where the answer is
                     * certain AND this screen still exists; a moment later the
                     * Server Action redirects and the route is gone. See
                     * `onAccepted` on EnrolmentInput for why the pause has to
                     * be opened from inside the enrolment rather than around
                     * it.
                     *
                     * The state goes to `success` at the same time, so the
                     * frame's border turns green under the celebration and the
                     * status line stops saying the comparison is running.
                     */
                    onAccepted: () => {
                        setMatchState('success');
                        setServerMessage(null);
                        setSubtitleKey('matchDone');
                        setCelebrating(true);
                        return new Promise<void>((resolve) =>
                            setTimeout(resolve, CELEBRATION_MS),
                        );
                    },
                    // Optional-chained: after a reload the selfie comes from
                    // the backend and `livenessResult` is null, so the
                    // confidence from that run is simply not available here.
                    // The backend already has it — the Worker committed it with
                    // the face — so omitting it costs nothing.
                    livenessConfidence: livenessResult?.metrics?.confidence,
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
                setServerMessage(null);
                setSubtitleKey('matchDone');
            } else {
                console.warn('[FaceMatch] Skipping submit — missing:', {
                    hasIdDocument: !!idDocument,
                    hasFace: !!selfie,
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
                    selfie
                        ? undefined
                        : 'Your photo could not be loaded. Open your access link again to restart.',
                );
            }
        } else {
            setMatchResult({
                isMatch: false,
                confidence: 0,
                similarity: 0,
                verdict: 'fail',
                errorMessage: data.message ?? t('matchNoMatch'),
            });
            // Same rule as above: the service's own wording goes to the
            // console, the screen gets the one fixed line.
            if (data.message) console.error('[FaceMatch] compare failed:', data.message);
            handleFailure();
        }
    }, [handleFailure, setMatchResult, goTo]);

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
        setServerMessage(null);
        setSubtitleKey('matchComparing');
        setAnimDone(false);
        hasFinalisedRef.current = false;
        apiResultRef.current = null;

        /**
         * The captured face — from memory, or refetched from the backend.
         *
         * ⚠️ The refetch is what makes a REFRESH survivable. `livenessResult`
         * is React state holding the frame, and a reload destroys it, so this
         * guard used to fail with `hasLiveFace: false` on a screen that was
         * visibly SHOWING the face — because the picture came from the stored
         * copy while the comparison still demanded the lost bytes.
         *
         * `/api/face-capture` serves that same stored image from our own
         * origin, so it can simply be fetched back. It is the frame Rekognition
         * judged, committed by the Worker — if anything a better source than
         * the browser's own copy, which was only ever the still it displayed.
         */
        let liveFace = livenessResult?.faceImageData ?? '';
        if (!liveFace && storedFaceSrc) {
            try {
                liveFace = await fetchStoredFace();
            } catch (err) {
                console.error('[FaceMatch] could not refetch the stored face:', err);
            }
        }
        resolvedFaceRef.current = liveFace || null;

        const idFace = idDocument?.idFaceImageData || idDocument?.frontImageData || '';

        if (!liveFace || !idFace) {
            console.error('[FaceMatch] missing face or ID image', {
                hasLiveFace: Boolean(liveFace),
                hasIdFace: Boolean(idFace),
            });
            // Name the cause. A missing FACE after a reload is not "your face
            // does not match your ID" — nothing was compared.
            handleFailure(
                !liveFace
                    ? 'Your photo could not be loaded. Open your access link again to restart.'
                    : undefined,
            );
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

    /**
     * What to DRAW. Falls back to the stored capture so a refresh shows a face
     * instead of a grey "Face Photo" box, and carries the look whichever source
     * it came from — so the picture beside the document is the one the person
     * posed for, not a harsher twin of it. See `useFacePhoto`.
     *
     * ⚠️ NOT WHAT GETS SUBMITTED, for three reasons now.
     *
     * The enrolment above still requires `livenessResult.faceImageData` — the
     * real bytes — because one of these sources is a URL, and a URL posted as
     * `selfie` is not an image. So a reloaded page can show you your face and
     * still, correctly, refuse to submit a capture it does not have.
     *
     * The look is the other two: skin smoothing attenuates exactly the
     * mid-frequency band CompareFaces reads, and the portrait blur softens the
     * boundary at the hair and jaw. Perfectly good to look at, and not
     * something to score a face on. `runMatch` above builds its OWN `liveFace`
     * from `faceImageData` / `fetchStoredFace()` — the untouched bytes — and
     * that is the one CompareFaces is given.
     *
     * ⚠️ Named `facePhoto`, not `liveFace`, deliberately. Both existed as
     * `liveFace` in this one component: the evidence inside `runMatch` and the
     * picture out here. Different scopes, so it compiled, but the two now
     * differ in a way that matters — one is retouched — and a later edit that
     * reached for the wrong one would quietly hand a smoothed face to a
     * comparison. Different things, different names.
     */
    const facePhoto = useFacePhoto(livenessResult, storedFaceSrc);
    const idImage = idDocument?.frontImageData || idDocument?.idFaceImageData;

    return (
        // `overflow-y-auto` is the last resort, the same one IDSummaryScreen
        // has: if the elastic space runs out the screen scrolls rather than
        // pushing Rematch off the bottom edge. At 932 there is slack, so nothing
        // scrolls and the frame is untouched.
        //
        // ⚠️ `px-20`, not the `px-40` this carried. On the 430 canvas that left
        // a 350 content box holding a `w-390` button — 40 over, running off the
        // side. IDSummaryScreen, which this screen is otherwise a twin of, has
        // always been `px-20`; the buttons were copied across and the padding
        // was not.
        <div className="thin-scroll items-center flex min-h-0 h-full flex-col overflow-y-auto bg-white px-20">
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
            <FlexSpace size={100} share={0} />
            <FlexSpace size={44} share={0.25} />

            <h1 className="fz-25 leading-none font-bold text-center text-[#1D1D1D] mb-5 shrink-0">
                {t('identityTitle')}
            </h1>
            {/*
              ⚠️ No `whitespace-nowrap`. This line is not always the short
              status it was designed around — when the backend sends its own
              message it can be a full sentence, and a nowrap line that long
              overflows the container in BOTH directions, running under the
              logo above and off the edge beside it. Wrapping is the only
              behaviour that is correct for every message it can be handed.

              `w-full` so the wrap happens at the content width rather than at
              whatever the flex row happens to be.
            */}
            <div className="flex w-full max-w-300 shrink-0 flex-wrap items-center justify-center gap-x-8 gap-y-4 mb-11">
                {/* `<Icon>`, not `<Image src={svg}>`: the glyphs live in
                    /public/icons and are recoloured by the mask (AGENTS.md §5).
                    Decorative here — the sentence beside them says it. */}
                <Icon name="kyc/face_detect" width={16} height={16} alt="" />
                <Icon name="kyc/id_detect" width={16} height={16} alt="" />
                <span className="fz-12 text-center leading-normal font-medium text-[#1D1D1D]">
                    {serverMessage ?? t(subtitleKey)}
                </span>
            </div>

            {/* Comparison stage: face (back) and ID (front, fading) on the same canvas */}
            <div
                // 280 x 320 — four fifths of the 350 x 400 it was. The screen
                // has more to say than the camera screens do (a status line
                // that can run to a sentence, a review banner, two buttons),
                // and the stage was taking room from all of it. The ID overlay
                // below is scaled by the same fifth so the composition inside
                // is unchanged.
                //
                // `shrink-0` holds it at exactly that everywhere. It is
                // the whole point of the screen — the user is being shown the
                // two images that were compared — so it is the one thing that
                // must not be resized to make room.
                //
                // LTR in every language, the same exception the camera frames
                // take (see IDCaptureScreen and FaceLivenessScreen). What is
                // inside is a photograph and a scanned card pinned to it at
                // measured offsets, plus the bracket that marks the face on
                // that card — an arrangement of images, not a line of reading.
                // Mirrored, the ID slides to the far side of the frame and the
                // bracket lands on the wrong part of the document. The screen's
                // own copy is outside this box and still mirrors.
                dir="ltr"
                className="relative mx-auto shrink-0 overflow-hidden rad-30 transition-colors duration-500 w-300 h-350 bg-[#E9EEEE]"
                style={{ border: `2px solid ${borderColor}` }}
            >
                {/* User face — always rendered */}
                {facePhoto ? (
                    <img
                        src={facePhoto}
                        alt="Face"
                        // Flipped from the same constant as IntroScreen and
                        // LivenessVerdict. Underneath the look this is the raw
                        // camera frame, and the preview it came from is
                        // mirrored. All three read `MIRROR_CLASS`, so they
                        // cannot disagree — one disagreeing is what made a face
                        // look reversed between steps.
                        //
                        // The retouching is display-only: what `runMatch` posts
                        // as `selfie` is built separately from the untouched
                        // bytes, and the server's comparison never sees this
                        // image.
                        className={`absolute inset-0 w-full h-full object-cover ${MIRROR_CLASS}`}
                        style={{ backgroundColor: '#E9EEEE' }}
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <span className="fz-12 text-[#707070]">{t('matchFacePhoto')}</span>
                    </div>
                )}

                {/* The face goes under the same pane as the intro screen — see
                    CAPTURE_PHOTO_GLASS (§9b) — but it does not hold still while
                    the comparison runs.

                    ── Why it waves ────────────────────────────────────────────
                    A fixed pane says "this picture is under glass". This screen
                    has to say "something is happening TO it", and it has
                    nothing true to say about how far along that is: the match
                    runs on a server and returns when it returns. So the glass
                    washes over the face instead — 0 to 50 and back, every 2.6s
                    — and at each trough the photograph is briefly sharp. It is
                    activity without a promise about duration, which is the one
                    honest thing a wait like this can draw.

                    50 is the PEAK here, not the setting. Once the verdict is in
                    there is no work left to show, so the wave stops and the
                    pane settles at a flat 25 — enough to keep the picture
                    consistent with the intro screen, out of the way of a result
                    the user is now reading.

                    ⚠️ THE OVERRIDE IS THE POINT, not an inconsistency with §9b.
                    The table's values are fractions of each pane's width, so 50
                    here and 50 there are the same sheet in proportion — and
                    proportion is not what the eye is judging. The intro shows
                    this face at 130px, an illustration beside a paragraph; this
                    screen shows it at 300px as one of the two things being
                    COMPARED, and the same sheet over a face that large hides
                    more of what the screen exists to show.

                    ⚠️ NOT over the document, and not over the scan line. The
                    pane is unlayered, so it paints in DOM order: above the face
                    and below the ID overlay (z-10) and the travelling line
                    (z-20), both of which are movement the glass would mute. The
                    ID is also a card of small print — the one thing on this
                    screen that has to stay sharp.

                    ⚠️ Cosmetic only, like every other display of this frame.
                    `runMatch` builds its evidence from the untouched bytes and
                    the server never sees anything this does. */}
                {facePhoto && (
                    <PhotoGlass
                        src={facePhoto}
                        width={300}
                        amount={matchState === 'matching' ? 50 : 25}
                        wave={matchState === 'matching'}
                        /*
                         * Ten at the bottom of the travel, not zero.
                         *
                         * A trough at zero takes the pane away entirely on
                         * every cycle, and what returns is not "less glass" but
                         * a bare photograph — the material appears and
                         * disappears rather than thickening and thinning. Ten
                         * is little enough to read as clear and enough to keep
                         * a sheet on the picture throughout, so the whole cycle
                         * is one object changing.
                         */
                        waveFloor={10}
                        className="rad-30"
                    />
                )}

                {/* The stars, while the model is working — twenty of them, five
                    to seven alight at a time. See SparkField: same glyph, same
                    gleam and same coupling of size to rotation as the AI mark,
                    spread over the frame rather than stacked in the middle of
                    it.

                    Above the glass and below the ID card, for the same reason
                    the pane is: what the card says has to stay readable, and a
                    star drifting over a birth date is noise on the one thing
                    the user might actually want to check.

                    Only while `matching`. They mean "a model is going over this
                    photograph" — true for exactly as long as that is running,
                    and a decoration the moment it is not. */}
                {matchState === 'matching' && <SparkField />}

                {/* The send-off. Above everything in the frame — the ID card,
                    the scan line, the glass — because for these three seconds
                    it IS the screen: the comparison is over and the things it
                    was made of have nothing left to say. See MatchCelebration
                    for why it only ever appears after acceptance. */}
                {celebrating && <MatchCelebration />}

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
                        className="absolute z-10 w-224 h-126 bottom-9 start-28"
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
                                        borderRadius: '0.375rem',
                                    }}
                                >
                                    <div className="absolute inset-0 rad-6" />
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
                <div className="mt-20 mx-auto max-w-300 rad-12 border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-16 py-12 text-center">
                    <p className="fz-12 text-center leading-normal font-medium text-[#92400E]">
                        {t('matchReview')}
                    </p>
                </div>
            )}
            {matchState === 'failed' && (
                <p className="fz-12 max-w-300 shrink-0 text-center leading-normal text-[#1D1D1D] mt-12 mb-20">
                    {t('matchFailed')}
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
                        {t('matchTryAgain')}
                    </button>
                    {/* <button
                        onClick={() => runMatch()}
                        title={t('matchRetry')}
                        aria-label={t('matchRetry')}
                        className="flex h-36 w-36 items-center justify-center rad-12 border border-[#5D5C5D]/40 text-[#4D84FF] transition-colors hover:border-[#4D84FF]"
                    >
                        <Icon name="kyc/retry" size={18} mask />
                    </button> */}
                </div>
            )}
            {/* 12 from the foot, STATIC — the flow-wide rule. */}
            <FlexSpace size={12} share={0} />
        </div>
    );
}

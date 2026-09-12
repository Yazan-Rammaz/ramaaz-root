'use client';

import { useRef } from 'react';
import { IdentityGate } from '@/features/kyc/components/IdentityGate';
import { createKycService } from '@/features/kyc/services';
import { isChallengeExpired } from '@/features/kyc/services/httpKycService';
import {
    restartSignInAction,
    submitFaceAction,
    submitIdentityDocumentAction,
} from '../actions';

/**
 * The client half of the identity stages — and the seam where the two services
 * meet.
 *
 * ── Why a captured frame takes two calls ────────────────────────────────────
 * The face image never reaches the auth backend. It goes to the KYC Worker,
 * which validates the challenge with the backend, downloads the enrolled
 * photograph, compares them with Rekognition, and commits what it measured over
 * an HMAC-signed server-to-server channel. The backend applies the thresholds
 * and mints a single-use `stepToken`.
 *
 * Only THAT token is posted to `/v1/auth/face`. So:
 *
 *     frame ──► Worker ──► stepToken ──► auth backend ──► next stage
 *
 * Posting the image straight to `/v1/auth/face` is what a first pass does, and
 * the backend answers `422 VALIDATION_FAILED` — correctly, because a raw image
 * proves nothing it can verify.
 *
 * ── `challengeId` is safe on the client ─────────────────────────────────────
 * It is an identifier, not a credential — explicitly so, which is why it exists
 * separately from the challenge token. The token stays in its httpOnly cookie
 * and is attached server-side by the KYC proxy; this only ever carries the id.
 */
export function IdentityStep({
    needsEnrollment,
    challengeId,
    hasStoredFace = false,
}: {
    needsEnrollment: boolean;
    challengeId: string;
    /** The backend kept a face from earlier in this sign-in. See the page. */
    hasStoredFace?: boolean;
}) {
    /**
     * The step token, parked between verifying and committing.
     *
     * Those used to be one call. They are split so the screen can play its
     * success animation before the commit — because committing REDIRECTS, and a
     * server action that redirects never returns, so anything the UI wanted to
     * show afterwards had nowhere to happen.
     *
     * A ref, not state: nothing renders from it, and a re-render between the two
     * halves would drop a single-use credential on the floor.
     */
    const stepToken = useRef<string | null>(null);
    /**
     * The scores from the verdict the parked token belongs to.
     *
     * A ref, and cleared with the token, for the same reason it is: both are
     * per-attempt. Holding them in state would let a re-render pair the photo
     * of one attempt with the confidence of another, and the backend would
     * store a record that never happened.
     */
    const scores = useRef<{
        faceMatchScore?: number;
        livenessConfidence?: number;
    } | null>(null);

    return (
        <IdentityGate
            needsEnrollment={needsEnrollment}
            challengeId={challengeId}
            hasStoredFace={hasStoredFace}
            /**
             * The AWS Face Liveness path, and the reason it exists: a photograph
             * of the enrolled administrator, held up on a second phone, passed
             * `onCapture` below and signed in. CompareFaces answers "same face"
             * and nothing about whether a person was there.
             *
             * The shape is deliberately the same as `onCapture` — the Worker is
             * asked, it answers with a stepToken, the token goes to the auth
             * backend. What differs is what we hand it. `onCapture` sends an
             * IMAGE the browser chose; this sends a SESSION ID, and the Worker
             * fetches the picture from AWS itself. That is the part a tampered
             * client cannot get around, and it is worth more than the liveness
             * score.
             *
             * ⚠️ The liveness score is measured but NOT thresholded here, nor in
             * the Worker — it travels to NestJS as `livenessConfidence` and
             * NestJS decides. If a spoof ever passes, that threshold is where to
             * look first.
             */
            onLivenessSession={async (sessionId) => {
                if (!challengeId) {
                    return { error: 'This sign-in is missing its challenge id.' };
                }

                let verdict;
                try {
                    verdict = await createKycService().submitReverify({
                        challengeId,
                        sessionId,
                    });
                } catch (err) {
                    // ⚠️ A 401 HERE IS THE CLOCK, not the document.
                    //
                    // Enrolment is the last step of a sequence that started at
                    // /auth/link, and the challenge lives ten minutes
                    // (CHALLENGE_MAX_AGE / AUTH_CHALLENGE_TTL). Capturing two
                    // ID sides, waiting on OCR and running the match can take
                    // longer than that — and when it does the Worker finds no
                    // credential and answers a bare 401.
                    //
                    // Reported as an error string, that surfaced as "ID
                    // Matching With Your Photo Not Correct": the screen blamed
                    // somebody's face for a stopwatch. Nothing was compared and
                    // nothing was wrong with the document.
                    //
                    // Re-opening the link mints a fresh challenge and returns
                    // them to whatever step the server still owes.
                    if (isChallengeExpired(err)) {
                        void restartSignInAction();
                        return undefined;
                    }
                    return {
                        error:
                            err instanceof Error && err.message
                                ? err.message
                                : 'The verification service is unavailable.',
                    };
                }

                if (verdict.status !== 'passed' || !verdict.stepToken) {
                    return {
                        error:
                            verdict.reason ??
                            verdict.message ??
                            'That did not match. Try again.',
                    };
                }

                // Verified. Park the token; `onLivenessPassed` spends it once
                // the screen has shown the result.
                stepToken.current = verdict.stepToken;
                // The scores belong to THIS verdict, so they are parked with
                // the token rather than re-read later — a retry replaces both
                // together and cannot pair one attempt's photo with another's
                // confidence.
                scores.current = {
                    faceMatchScore: verdict.faceMatchScore,
                    livenessConfidence: verdict.livenessConfidence,
                };
                return undefined;
            }}
            /**
             * Spend the step token and move to the next stage — after the
             * success animation, not the moment the verdict lands.
             *
             * Cleared BEFORE the call, not after: it is single-use, and a retry
             * that re-posted a spent token would fail in a way that reads as a
             * failed face check rather than a spent credential.
             */
            onLivenessPassed={async (faceCapturedPhoto) => {
                const token = stepToken.current;
                const measured = scores.current;
                stepToken.current = null;
                scores.current = null;
                if (!token) return { error: 'This verification has already been used.' };
                const result = await submitFaceAction(token, {
                    faceCapturedPhoto,
                    ...measured,
                });
                // ⚠️ `restart` means the CHALLENGE is gone, not that this
                // step was refused — so there is nothing to show and nothing to
                // retry. Dropping it (which this did, by returning only
                // `error`) left a message on screen beside a button that could
                // not work. Re-open the link instead: it mints a fresh
                // challenge and returns to whatever the server still owes.
                if (result?.restart) {
                    void restartSignInAction();
                    return undefined;
                }
                return result?.error ? { error: result.error } : undefined;
            }}
            onCapture={async (frame) => {
                if (!challengeId) {
                    return { error: 'This sign-in is missing its challenge id.' };
                }

                let verdict;
                try {
                    verdict = await createKycService().submitReverify({
                        challengeId,
                        liveFaceImageData: frame,
                    });
                } catch (err) {
                    // A transport failure, not a verdict — the Worker answers
                    // with a body even when it rejects, so reaching here means
                    // it could not be reached at all.
                    return {
                        error:
                            err instanceof Error && err.message
                                ? err.message
                                : 'The verification service is unavailable.',
                    };
                }

                if (verdict.status !== 'passed' || !verdict.stepToken) {
                    // The backend decided this, not us. Show its reason when it
                    // gave one rather than inventing a friendlier lie.
                    return {
                        error:
                            verdict.reason ??
                            verdict.message ??
                            'That did not match. Try again.',
                    };
                }

                const result = await submitFaceAction(verdict.stepToken);
                // ⚠️ `restart` means the CHALLENGE is gone, not that this
                // step was refused — so there is nothing to show and nothing to
                // retry. Dropping it (which this did, by returning only
                // `error`) left a message on screen beside a button that could
                // not work. Re-open the link instead: it mints a fresh
                // challenge and returns to whatever the server still owes.
                if (result?.restart) {
                    void restartSignInAction();
                    return undefined;
                }
                return result?.error ? { error: result.error } : undefined;
            }}
            onEnroll={async ({ idDocument, selfie }) => {
                if (!challengeId) {
                    return { error: 'This sign-in is missing its challenge id.' };
                }

                // ── Two calls, and the split is the security model ───────────
                // The images go to the WORKER, which re-reads the document,
                // re-runs the comparison on those exact bytes, and commits what
                // it measured to the backend over its own signed channel. Only
                // the resulting stepToken is posted to /auth/identity-document.
                // No document and no face reaches the auth backend from here —
                // the same shape as the face step above, for the same reason.
                //
                // Note what is NOT sent: the OCR fields and the match score.
                // This client holds both already, and the Worker ignores them
                // on purpose — a score a client can choose is a score an
                // attacker can choose, and the Worker signs what it sends.
                let verdict;
                try {
                    verdict = await createKycService().enrollDocument({
                        challengeId,
                        frontImage: idDocument.frontImageData,
                        // A passport is one page; sending an absent reverse
                        // would enrol a blank image as a document side.
                        backImage: idDocument.backImageData || undefined,
                        selfieImage: selfie,
                        // A hint only — Textract's own reading wins Worker-side.
                        documentType: idDocument.idType ?? undefined,
                    });
                } catch (err) {
                    // ⚠️ A 401 HERE IS THE CLOCK, not the document.
                    //
                    // Enrolment is the last step of a sequence that started at
                    // /auth/link, and the challenge lives ten minutes
                    // (CHALLENGE_MAX_AGE / AUTH_CHALLENGE_TTL). Capturing two
                    // ID sides, waiting on OCR and running the match can take
                    // longer than that — and when it does the Worker finds no
                    // credential and answers a bare 401.
                    //
                    // Reported as an error string, that surfaced as "ID
                    // Matching With Your Photo Not Correct": the screen blamed
                    // somebody's face for a stopwatch. Nothing was compared and
                    // nothing was wrong with the document.
                    //
                    // Re-opening the link mints a fresh challenge and returns
                    // them to whatever step the server still owes.
                    if (isChallengeExpired(err)) {
                        void restartSignInAction();
                        return undefined;
                    }
                    return {
                        error:
                            err instanceof Error && err.message
                                ? err.message
                                : 'The verification service is unavailable.',
                    };
                }

                if (verdict.status !== 'passed' || !verdict.stepToken) {
                    // The backend decided this. Show its reason rather than
                    // inventing a friendlier one.
                    return {
                        error:
                            verdict.reason ??
                            verdict.message ??
                            'That document could not be enrolled. Try again.',
                    };
                }

                const result = await submitIdentityDocumentAction({
                    step_token: verdict.stepToken,
                });
                // ⚠️ `restart` means the CHALLENGE is gone, not that this
                // step was refused — so there is nothing to show and nothing to
                // retry. Dropping it (which this did, by returning only
                // `error`) left a message on screen beside a button that could
                // not work. Re-open the link instead: it mints a fresh
                // challenge and returns to whatever the server still owes.
                if (result?.restart) {
                    void restartSignInAction();
                    return undefined;
                }
                return result?.error ? { error: result.error } : undefined;
            }}
        />
    );
}

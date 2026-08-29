'use client';

import { IdentityGate } from '@/features/kyc/components/IdentityGate';
import { createKycService } from '@/features/kyc/services';
import { submitFaceAction, submitIdentityDocumentAction } from '../actions';

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
}: {
    needsEnrollment: boolean;
    challengeId: string;
}) {
    return (
        <IdentityGate
            needsEnrollment={needsEnrollment}
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
                return result?.error ? { error: result.error } : undefined;
            }}
        />
    );
}

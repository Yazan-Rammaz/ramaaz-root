'use client';

import React, { useCallback } from 'react';
import Image from 'next/image';
import { MAX_ATTEMPTS, useVerification } from '@/features/kyc/context/VerificationContext';
import { useRouter } from 'next/navigation';
import { createKycService } from '@/features/kyc/services';
import ExitConfirmDialog from '../ExitConfirmDialog';
import liveDetectIdSvg from '@/features/kyc/assets/live-detect-id.svg';
import shieldSvg from '@/features/kyc/assets/shield.svg';
import { FlexSpace } from '@/components/ui/FlexSpace';

export default function IDSummaryScreen() {
    const {
        goTo,
        idDocument,
        livenessResult,
        setIdDocument,
        markCompleted,
        attemptCounts,
        incrementAttempt,
    } = useVerification();
    const router = useRouter();
    const [showExitDialog, setShowExitDialog] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [submitError, setSubmitError] = React.useState<string | null>(null);

    const kycService = React.useRef(createKycService());
    const isPassport = (idDocument?.idType ?? '').toLowerCase().includes('passport');

    const fields = [
        { label: 'ID Type', value: idDocument?.idName || idDocument?.idType || '—' },
        { label: 'Country', value: idDocument?.country || '—' },
        { label: 'Name', value: idDocument?.name || '—' },
        {
            label: isPassport ? 'Passport Number' : 'National Number',
            value: idDocument?.nationalNumber || idDocument?.documentNumber || '—',
        },
        { label: 'Birthday', value: idDocument?.birthday || '—' },
    ];

    async function handleSubmit() {
        if (!idDocument) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            // await kycService.current.submitVerification({
            //     frontImageData: idDocument.frontImageData,
            //     backImageData: idDocument.backImageData,
            //     selfieImageData: livenessResult?.faceImageData ?? undefined,
            //     extracted: {
            //         idType: idDocument.idType,
            //         country: idDocument.country,
            //         name: idDocument.name,
            //         nationalNumber: idDocument.nationalNumber,
            //         birthday: idDocument.birthday,
            //     },
            // });
            markCompleted('id-summary');
            // Straight to the comparison — the face was already captured, at
            // the very first step of this flow.
            //
            // 'face-detection' used to sit here and ask for a SECOND capture.
            // It is not gone (VerificationPage still routes it, AwsFaceLiveness
            // is untouched), it is simply no longer in the path: the frame
            // taken before ID capture is the one FaceMatchScreen compares
            // against the ID, so asking again photographed the same person
            // twice to answer a question already answered.
            //
            // This only works because the frame SURVIVES the ID steps — it
            // lives in VerificationContext, which is why IdentityGate must not
            // remount the provider mid-flow. Break that and this jump lands on
            // "Missing face or ID image" (FaceMatchScreen.tsx:213).
            goTo('face-match', 1);
        } catch (err) {
            setSubmitError(
                err instanceof Error
                    ? err.message
                    : 'Submission failed. Please check your connection and try again.',
            );
        } finally {
            setSubmitting(false);
        }
    }
    const handleFailure = useCallback(() => {
        // const count = incrementAttempt('id-capture-front');
        // if (count >= MAX_ATTEMPTS) {
        //     goTo('contact-support', 1);
        // } else {
        setIdDocument(null);
        goTo('id-capture-front', -1);
        // }
    }, [incrementAttempt, goTo]);
    return (
        // `overflow-y-auto` is the floor under everything below: once the
        // elastic space is spent this screen scrolls instead of pushing its
        // last button off the bottom edge. On a 932 canvas nothing scrolls —
        // there is slack — so this costs the design nothing.
        <div className="thin-scroll flex min-h-0 h-full flex-col overflow-y-auto bg-white px-20">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => router.push('/home')}
            />

            {/*
              ── What gives on a short screen ─────────────────────────────────
              The blocks below all carry `shrink-0`, so a viewport shorter than
              the frame takes its shortfall out of the three spacers and nothing
              else. Without that every item shrank a little, and the one that
              showed it was the space above the heading: 90 at 932, but 15 in
              Safari at 745 — the title all but touching the toolbar.

              Shares total 1, and they rank what the user should lose last: the
              90 under the field list carries most of it (0.55), then the top
              margin (0.20), then the three 16s between blocks (0.05 each), then
              the foot (0.10). The two margins go last on purpose — a margin
              that collapses reads as a bug rather than as a tight fit.

              ── Both margins are split rigid + elastic, and that is the point ─
              Flexbox does not distribute a shortfall once. It freezes whatever
              hits zero and re-splits the remainder among the survivors, so the
              last spacer standing absorbs everything left — which is how a
              margin that was only ever meant to give a little ends up at 15px.
              A rigid first half is a floor the algorithm cannot dip below, so
              the elastic half can give freely without the margin collapsing.
              Top is 48 rigid + 52 elastic, still the 100 the frame asks for.
              The foot is a flat, rigid 12 — the flow-wide rule, and the one gap
              nothing is allowed to take.

              ⚠️ This screen is TALLER than a Safari viewport (~934 against 745)
              and no spacing can fix that: it is heading, two 109-tall
              thumbnails, five fields, a badge and two buttons, all content.
              Once the elastic space is spent the root scrolls. Losing the
              bottom button off the edge — which is what happened before — is
              the one outcome that is not acceptable.
            */}
            <FlexSpace size={48} share={0} />
            <FlexSpace size={52} share={0.2} />
            {/* Header */}
            <h1 className="fz-30 font-bold text-center text-[#1D1D1D] mb-5 shrink-0">
                Identity Verification !
            </h1>
            <div className="flex shrink-0 items-center justify-center gap-8 mb-11">
                <Image
                    src={liveDetectIdSvg}
                    alt="live detect ID"
                    className="object-contain w-20 h-20"
                />
                <span className="fz-16 font-medium text-[#1D1D1D]">Live Detection Your ID</span>
            </div>

            {/* ID thumbnails */}
            {isPassport ? (
                <div className="flex shrink-0 justify-center">
                    <div className="text-center">
                        <p className="fz-12 text-[#8D8D8D] mb-4">Passport</p>
                        <div className="w-193 h-109 rad-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {idDocument?.frontImageData ? (
                                <img
                                    src={idDocument.frontImageData}
                                    alt="Passport"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full bg-gray-200" />
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="shrink-0">
                    {/* <div className="flex mb-4">
                        <p className="fz-12 text-[#8D8D8D] flex-1 text-center">Front Side</p>
                        <p className="fz-12 text-[#8D8D8D] flex-1 text-center">Back Side</p>
                    </div> */}
                    <div className="flex gap-5">
                        <div className=" w-193 h-109 rad-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {idDocument?.frontImageData ? (
                                <img
                                    src={idDocument.frontImageData}
                                    alt="Front ID"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full bg-gray-200" />
                            )}
                        </div>
                        <div className=" w-193 h-109 rad-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {idDocument?.backImageData ? (
                                <img
                                    src={idDocument.backImageData}
                                    alt="Back ID"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full bg-gray-200" />
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* The three 16s between the blocks below are spacers rather than
                margins so they can give too. They are 16 at the design height —
                nothing about the frame changes — but on a short screen they are
                the last resort after the big gap, the top margin and the foot
                have all been spent, and without them this screen could not fit
                a Safari viewport at all. */}
            <FlexSpace size={16} share={0.05} />

            {/* Information Detected heading */}
            <div className="flex shrink-0 justify-center items-center gap-8">
                <Image
                    src={liveDetectIdSvg}
                    alt="information detected"
                    className="object-contain shrink-0 w-20 h-20"
                />
                <span className="fz-16 font-medium text-[#1D1D1D]">Information Detected</span>
            </div>

            <FlexSpace size={16} share={0.05} />

            {/* Fields */}
            <div className="flex shrink-0 flex-col gap-5">
                {fields.map(({ label, value }) => (
                    <div key={label} className="h-55 w-390 bg-[#FCFCFC] p-10 rad-15">
                        <p className="fz-12 text-[#8D8D8D] pb-3">{label}</p>
                        <p className="fz-14 text-[#1D1D1D]">{value}</p>
                    </div>
                ))}
            </div>
            <FlexSpace size={16} share={0.05} />
            <FlexSpace size={90} share={0.65} />
            <div className="mt-auto flex shrink-0 items-center flex-col justify-end">
                {/* Privacy badge */}
                <div className="flex items-center flex-col justify-center gap-8 mb-12">
                    <Image src={shieldSvg} alt="shield" className="w-15 h-15 object-contain" />
                    <span className="fz-12 text-[#388CFF]">Your Privacy Is Completely Safe</span>
                </div>

                {/* Submission error */}
                {submitError && (
                    <p className="fz-12 text-[#E53E3E] text-center mb-12 px-8">{submitError}</p>
                )}

                {/* CTAs */}
                <button
                    onClick={handleSubmit}
                    disabled={submitting}
                    // mb-12 — the flow-wide gap between a button and the text
                    // link under it. "Incorrect, Try Again" is the escape hatch
                    // from this button, not a separate section.
                    className="mb-12 w-390 h-60 py-16 rad-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] fz-16 font-medium disabled:opacity-50"
                >
                    {'Correct, Next'}
                </button>
                <button
                    onClick={handleFailure}
                    disabled={submitting}
                    className="w-full text-center text-sm text-[#388CFF] hover:underline disabled:opacity-40"
                >
                    Incorrect, Try Again
                </button>
            </div>
            {/* 12 from the foot, STATIC — the same 12 every screen in the flow
                ends on. Rigid on purpose: it is the one gap a short viewport
                must not be allowed to take. */}
            <FlexSpace size={12} share={0} />
        </div>
    );
}

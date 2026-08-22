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
            goTo('face-detection', 1);
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
        <div className="flex flex-col h-full bg-white px-20">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => router.push('/home')}
            />

            {/* Close button */}
            <div className="flex absolute top-50 end-30 justify-end mb-8">
                <button
                    onClick={() => setShowExitDialog(true)}
                    className="text-red-400 hover:text-red-600"
                >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path
                            d="M5 5L15 15M15 5L5 15"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            </div>

            <FlexSpace size={100} share={0.4} />
            {/* Header */}
            <h1 className="fz-30 font-bold text-center text-[#1D1D1D] mb-5">
                Identity Verification !
            </h1>
            <div className="flex items-center justify-center gap-8 mb-11">
                <Image
                    src={liveDetectIdSvg}
                    alt="live detect ID"
                    className="object-contain w-20 h-20"
                />
                <span className="fz-16 font-medium text-[#1D1D1D]">
                    Live Detection Your ID
                </span>
            </div>

            {/* ID thumbnails */}
            {isPassport ? (
                <div className="flex justify-center mb-16">
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
                <div className="mb-16">
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

            {/* Information Detected heading */}
            <div className="flex justify-center items-center gap-8 mb-16">
                <Image
                    src={liveDetectIdSvg}
                    alt="information detected"
                    className="object-contain shrink-0 w-20 h-20"
                />
                <span className="fz-16 font-medium text-[#1D1D1D]">Information Detected</span>
            </div>

            {/* Fields */}
            <div className="flex flex-col gap-5 mb-16">
                {fields.map(({ label, value }) => (
                    <div
                        key={label}
                        className="h-55 w-390 bg-[#FCFCFC] p-10 rad-15"
                    >
                        <p className="fz-12 text-[#8D8D8D] pb-3">{label}</p>
                        <p className="fz-14 text-[#1D1D1D]">{value}</p>
                    </div>
                ))}
            </div>
            <FlexSpace size={90} share={0.7} />
            <div className="mt-auto flex items-center flex-col justify-end">
                {/* Privacy badge */}
                <div className="flex items-center flex-col justify-center gap-8 mb-12">
                    <Image
                        src={shieldSvg}
                        alt="shield"
                        className="w-15 h-15 object-contain"
                    />
                    <span className="fz-12 text-[#388CFF]">
                        Your Privacy Is Completely Safe
                    </span>
                </div>

                {/* Submission error */}
                {submitError && (
                    <p className="fz-12 text-[#E53E3E] text-center mb-12 px-8">{submitError}</p>
                )}

                {/* CTAs */}
                <button
                    onClick={handleSubmit}
                    disabled={submitting}
                    className="mb-30 w-390 h-60 py-16 rad-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] fz-16 font-medium disabled:opacity-50"
                >
                    {'Correct, Next'}
                </button>
                <button
                    onClick={handleFailure}
                    disabled={submitting}
                    className="w-full text-center text-sm text-[#388CFF] hover:underline mb-8 disabled:opacity-40"
                >
                    Incorrect, Try Again
                </button>
            </div>
            <FlexSpace size={35} share={0} />
        </div>
    );
}

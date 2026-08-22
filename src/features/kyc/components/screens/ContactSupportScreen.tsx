'use client';

import React, { useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import shieldSvg from '@/features/kyc/assets/shield.svg';
import liveDetectIdSvg from '@/features/kyc/assets/live-detect-id.svg';
import ExitConfirmDialog from '../ExitConfirmDialog';
import { useVerification } from '@/features/kyc/context/VerificationContext';

export default function ContactSupportScreen() {
    const router = useRouter();
    const { idDocument } = useVerification();
    const isPassport = (idDocument?.idType ?? '').toLowerCase().includes('passport');
    const [showExitDialog, setShowExitDialog] = React.useState(false);
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

    useEffect(() => {
        console.log(`idDocument: ${idDocument}`);
    }, [idDocument]);
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

            {/* Header */}
            <h1 className="fz-30 font-bold text-center text-[#1D1D1D] mb-5  mt-100">
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
                <div className="flex gap-5 mb-16">
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
            <div className="mt-auto mb-35 flex items-center flex-col justify-end">
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

                {/* CTAs */}
                <button
                    disabled={true}
                    className="mb-30 w-390 h-60 bg-[#FCFCFC] py-16 rad-20  text-[#1D1D1D] fz-16 font-medium"
                >
                    Will Contact With You Soon
                </button>
                <button disabled={true} className="w-full text-center text-sm text-[#388CFF] mb-8">
                    Within 2 Hour
                </button>
            </div>
        </div>
    );
}

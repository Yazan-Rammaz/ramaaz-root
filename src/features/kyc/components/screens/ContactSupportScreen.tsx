'use client';

import React, { useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import shieldSvg from '@/features/kyc/assets/shield.svg';
import liveDetectIdSvg from '@/features/kyc/assets/live-detect-id.svg';
import ExitConfirmDialog from '../ExitConfirmDialog';
import { FlexSpace } from '@/components/ui/FlexSpace';
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
        // `overflow-y-auto` is the floor under everything below: once the
        // elastic space is spent this screen scrolls instead of pushing its last
        // control off the bottom edge. At 932 there is slack, so nothing scrolls.
        <div className="thin-scroll flex min-h-0 h-full flex-col overflow-y-auto bg-white px-20">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => router.push('/home')}
            />

            {/*
              ── Spaced exactly like IDSummaryScreen, because it IS that screen ─
              Same heading, same thumbnails, same five fields, same badge, same
              button-plus-text-link foot — it is the summary after the flow has
              given up. Two screens this alike must not drift apart in their
              spacing, so the numbers below are copied deliberately rather than
              re-derived: 48 rigid + 52 elastic at the top, three elastic 16s
              between the blocks, 90 above the foot, 12 static under it.

              The top margin is split rigid + elastic for the reason spelled out
              in IDSummaryScreen: flexbox freezes whatever hits zero and
              re-splits the remainder among the survivors, so the last spacer
              standing absorbs everything and a margin meant to give a little
              collapses entirely. Shares total 1: 0.20 top, 0.05 x3 between,
              0.65 above the foot.

              This replaces a flat `mt-100`, which could not give at all — the
              screen simply ran off the bottom, by 10 in Safari at 796 and 61 at
              745, taking "Within 2 Hour" with it.
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
                <span className="fz-16 font-medium text-[#1D1D1D]">
                    Live Detection Your ID
                </span>
            </div>
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
                <div className="flex shrink-0 gap-5">
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
            {/* The three 16s between the blocks are spacers rather than margins
                so they can give too — 16 at the design height, and the last
                resort once the top margin and the 90 are spent. */}
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
                    <div
                        key={label}
                        className="h-55 w-390 bg-[#FCFCFC] p-10 rad-15"
                    >
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
                    // mb-12 — the flow-wide gap between a button and the text
                    // link under it.
                    className="mb-12 w-390 h-60 bg-[#FCFCFC] py-16 rad-20  text-[#1D1D1D] fz-16 font-medium"
                >
                    Will Contact With You Soon
                </button>
                <button disabled={true} className="w-full text-center text-sm text-[#388CFF]">
                    Within 2 Hour
                </button>
            </div>

            {/* 12 from the foot, STATIC — the flow-wide rule, and the one gap
                nothing is allowed to take. */}
            <FlexSpace size={12} share={0} />
        </div>
    );
}

'use client';

import React from 'react';
import Image from 'next/image';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useRouter } from 'next/navigation';
import { useKycSession } from '@/features/kyc/context/KycSessionContext';
import shieldSvg from '@/features/kyc/assets/shield.svg';
import notVerifiedSvg from '@/features/kyc/assets/not-verified.svg';

export default function IntroScreen() {
    const { goTo } = useVerification();
    const router = useRouter();
    const { userData } = useKycSession();

    const userName = userData?.user?.firstName || userData?.user?.lastName || 'RDB User';

    const handleStart = () => {
        goTo('id-capture-front', 1);
    };

    const handleLater = () => {
        router.push('/home');
    };

    return (
        <div className="flex flex-col h-full bg-[#FFFDD0] px-40 py-0">
            {/* Top spacer */}
            <div className="h-1/2 flex items-end justify-center">
                {/* Main content */}
                <div className="flex flex-col items-start">
                    <h1 className="fz-30 font-bold text-[#1D1D1D] mb-10">
                        Identity Verification !
                    </h1>
                    <p className="fz-16 font-medium text-[#1D1D1D] mb-8">
                        Protect Your Account & Get Full Access
                    </p>
                    <p className="fz-12 text-[#1D1D1D] leading-relaxed mb-10">
                        We Need To Verify Your Identity Once To Protect Your Account From Fraud And
                        Comply With Security Regulations One-Time Process To Confirm That You. It
                        Helps Keep Your Account Secure, Prevents Fraud, And Ensures Safe
                        Transactions Just Like Showing Your ID When Opening A Bank Account.
                    </p>

                    {/* User name with badge */}
                    <div className="flex items-center gap-12">
                        <span className="fz-12 text-[#1D1D1D]">{userName}</span>
                        <Image
                            src={notVerifiedSvg}
                            alt="not verified"
                            className="w-15 h-15 object-contain"
                        />
                    </div>
                </div>
            </div>
            {/* Bottom spacer */}

            <div className="h-1/2 flex items-end justify-center">
                <div className="flex flex-col">
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

                    {/* Start Verification button */}
                    <button
                        onClick={handleStart}
                        className=" py-16 w-390 h-60 rad-20 bg-[#FCFCFC] border border-[#5D5C5D]/50 border-dashed text-[#5D5C5D] fz-16 font-medium mb-30"
                    >
                        Start Verification
                    </button>

                    {/* Later link */}
                    <button
                        onClick={handleLater}
                        className="w-full text-center fz-14 text-[#388CFF] hover:underline mb-35"
                    >
                        Later, Use The Limited Version
                    </button>
                </div>
            </div>
        </div>
    );
}

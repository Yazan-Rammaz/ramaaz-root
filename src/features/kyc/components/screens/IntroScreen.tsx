'use client';

import React from 'react';
import Image from 'next/image';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useRouter } from 'next/navigation';
// TODO(kyc-port): rdb AuthContext — updateUser/userData come from the dashboard session
// import { useAuth } from '@/context/AuthContext';
import shieldSvg from '@/features/kyc/assets/shield.svg';
import notVerifiedSvg from '@/features/kyc/assets/not-verified.svg';

export default function IntroScreen() {
    const { goTo } = useVerification();
    const router = useRouter();
    const { userData } = useAuth();

    const userName = userData?.user?.firstName || userData?.user?.lastName || 'RDB User';

    const handleStart = () => {
        goTo('id-capture-front', 1);
    };

    const handleLater = () => {
        router.push('/home');
    };

    return (
        <div className="flex flex-col h-full bg-[#FFFDD0] px-xd-40 py-0">
            {/* Top spacer */}
            <div className="h-1/2 flex items-end justify-center">
                {/* Main content */}
                <div className="flex flex-col items-start">
                    <h1 className="text-xd-30 font-bold text-[#1D1D1D] mb-xd-10">
                        Identity Verification !
                    </h1>
                    <p className="text-xd-16 font-medium text-[#1D1D1D] mb-xd-8">
                        Protect Your Account & Get Full Access
                    </p>
                    <p className="text-xd-12 text-[#1D1D1D] leading-relaxed mb-xd-10">
                        We Need To Verify Your Identity Once To Protect Your Account From Fraud And
                        Comply With Security Regulations One-Time Process To Confirm That You. It
                        Helps Keep Your Account Secure, Prevents Fraud, And Ensures Safe
                        Transactions Just Like Showing Your ID When Opening A Bank Account.
                    </p>

                    {/* User name with badge */}
                    <div className="flex items-center gap-xd-12">
                        <span className="text-xd-12 text-[#1D1D1D]">{userName}</span>
                        <Image
                            src={notVerifiedSvg}
                            alt="not verified"
                            className="w-xd-15 h-xd-15 object-contain"
                        />
                    </div>
                </div>
            </div>
            {/* Bottom spacer */}

            <div className="h-1/2 flex items-end justify-center">
                <div className="flex flex-col">
                    {/* Privacy badge */}
                    <div className="flex items-center flex-col justify-center gap-2 mb-xd-12">
                        <Image
                            src={shieldSvg}
                            alt="shield"
                            className="w-xd-15 h-xd-15 object-contain"
                        />
                        <span className="text-xd-12 text-[#388CFF]">
                            Your Privacy Is Completely Safe
                        </span>
                    </div>

                    {/* Start Verification button */}
                    <button
                        onClick={handleStart}
                        className=" py-4 w-xd-390 h-xd-60 rounded-[20px] bg-[#FCFCFC] border border-[#5D5C5D]/50 border-dashed text-[#5D5C5D] text-xd-16 font-medium mb-xd-30"
                    >
                        Start Verification
                    </button>

                    {/* Later link */}
                    <button
                        onClick={handleLater}
                        className="w-full text-center text-xd-14 text-[#388CFF] hover:underline mb-xd-35"
                    >
                        Later, Use The Limited Version
                    </button>
                </div>
            </div>
        </div>
    );
}

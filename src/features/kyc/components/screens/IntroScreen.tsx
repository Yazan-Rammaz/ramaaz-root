'use client';

import Image from 'next/image';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useKycSession } from '@/features/kyc/context/KycSessionContext';
import infoSvg from '@/features/kyc/assets/shield.svg';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Consent, and the first thing an administrator sees on a first login.
 *
 * ── The photo is the one just captured ──────────────────────────────────────
 * Not the stored reference, and not a fresh capture: it is the frame from the
 * face step, held in `VerificationContext` for the whole flow. Showing it back
 * is the point — it says "this is who we just verified you as" before asking
 * for consent, rather than asking someone to agree to something abstract.
 *
 * It is also why this screen and the face step share a route. A navigation
 * between them would drop the frame (it is React state, far too large for a
 * cookie), and the administrator would have to capture their face twice — the
 * one thing this flow is built to avoid.
 *
 * ── Disagree and Terms are inert, by request ────────────────────────────────
 * Both are rendered because they are in the design, and both are disabled: the
 * terms document does not exist yet, and refusing consent mid-challenge has no
 * defined outcome. Shown-but-disabled is the honest state — a live control that
 * silently did nothing would be worse than one that plainly cannot be pressed.
 */
export default function IntroScreen() {
    const { goTo, livenessResult } = useVerification();
    const { userData } = useKycSession();

    // Supplied by the backend on the face-check response. Absent until that
    // lands, so the greeting degrades to just "Welcome !" rather than showing a
    // placeholder name that is not this person's.
    const fullName = [userData?.user?.firstName, userData?.user?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

    const photo = livenessResult?.faceImageData;

    return (
        <div className="flex h-full flex-col items-center justify-center px-40">
            <div className="flex w-346 flex-col items-start">
                {/* The frame captured moments ago, in the face step. */}
                {photo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a
                    // data: URL held in memory; next/image would need a loader
                    // and would gain nothing over a 115px square.
                    <img
                        src={photo}
                        alt=""
                        className="h-115 w-115 self-center rad-20 object-cover"
                    />
                ) : (
                    <div className="h-115 w-115 self-center rad-20 bg-[#F2F2F2]" />
                )}

                <p
                    className="fz-16 self-center leading-none text-[#1D1D1D]"
                    style={{ marginTop: rem(20) }}
                >
                    {fullName ? (
                        <>
                            <span className="font-normal text-[#707070]">{fullName}</span>
                            <span className="font-medium">, Welcome !</span>
                        </>
                    ) : (
                        <span className="font-medium">Welcome !</span>
                    )}
                </p>

                <h1
                    className="fz-30 self-start leading-none font-bold text-[#1D1D1D]"
                    style={{ marginTop: rem(24) }}
                >
                    Your First Login Root !
                </h1>

                <p
                    className="fz-14 leading-normal font-medium text-[#1D1D1D]"
                    style={{ marginTop: rem(20) }}
                >
                    You Are Required To Identity Verification &amp; Read And Agree To The
                    Agreement And Terms Of Use.
                </p>

                <p
                    className="fz-12 leading-normal font-normal text-[#707070]"
                    style={{ marginTop: rem(12) }}
                >
                    Consent Constitutes A Full And Binding Commitment, And Shall Be
                    Considered A Formal Legal Contract In Accordance With The Applicable
                    Laws And Provisions. If You Do Not Agree, Please Refrain From
                    Proceeding And Click <span className="font-bold">&ldquo;Disagree&rdquo;</span>.
                </p>

                {/* Inert — the terms document does not exist yet. */}
                <div
                    className="flex w-full flex-col items-center gap-6"
                    style={{ marginTop: rem(40) }}
                >
                    <Image src={infoSvg} alt="" width={16} height={16} />
                    <span
                        aria-disabled
                        className="fz-12 leading-none font-normal text-[#388CFF] opacity-60"
                    >
                        Terms Of Services
                    </span>
                </div>

                <button
                    type="button"
                    onClick={() => goTo('id-capture-front', 1)}
                    className="hairline fz-16 h-56 w-full rad-28 leading-none font-normal text-[#707070] transition-colors hover:text-[#1D1D1D]"
                    style={
                        {
                            marginTop: rem(48),
                            '--hairline-radius': rem(28),
                            '--hairline-color': '#C3C3C3',
                            '--hairline-dash': '3 3',
                        } as React.CSSProperties
                    }
                >
                    Start Identity Verification
                </button>

                {/* Inert — refusing consent mid-challenge has no defined outcome. */}
                <button
                    type="button"
                    disabled
                    className="fz-14 w-full cursor-not-allowed leading-none font-medium text-[#1D1D1D] opacity-40"
                    style={{ marginTop: rem(24) }}
                >
                    Disagree
                </button>
            </div>
        </div>
    );
}

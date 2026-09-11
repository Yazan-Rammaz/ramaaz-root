'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { FlexSpace } from '@/components/ui/FlexSpace';
import { useVerification } from '@/features/kyc/context/VerificationContext';
import { useKycSession } from '@/features/kyc/context/KycSessionContext';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Consent, and the first thing an administrator sees on a first login.
 *
 * XD (430 canvas): a 390 column. Photo 130 x 148 at y=288, then the greeting
 * (16 medium), the heading (30 bold), the requirement line (14 medium / 18),
 * the consent paragraph (12 regular), the terms link, the dashed 390 x 60
 * button, and "Disagree" 127 up from the foot. Every gap is a <FlexSpace>.
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
 * ── Which gaps give on a short screen ───────────────────────────────────────
 * The frame's gaps add up to more than a short phone has, so three of them are
 * elastic and the rest are rigid: the 288 above the photo takes half of any
 * shortfall, the 127 at the foot takes a third, and the 50 above the button
 * takes the rest. That order is deliberate — the block from the greeting to the
 * consent paragraph is one piece of reading, and squeezing gaps inside it is
 * what makes a legal notice look accidental. At or above the frame's height
 * every number below is exactly what XD says.
 *
 * ── Disagree and Terms are inert, by request ────────────────────────────────
 * Both are rendered because they are in the design, and neither does anything:
 * the terms document does not exist yet, and refusing consent mid-challenge has
 * no defined outcome. They are drawn at the design's full strength rather than
 * faded, so they LOOK live — `disabled` / `aria-disabled` keep assistive tech
 * honest, but a sighted person gets no hint. Worth revisiting.
 */
export default function IntroScreen() {
    const t = useTranslations('auth');
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
        <div className="mx-auto flex h-full w-390 flex-col">
            <FlexSpace size={288} share={0.5} />

            {/* The frame captured moments ago, in the face step. */}
            {photo ? (
                // A data: URL held in memory; next/image would need a loader and
                // would gain nothing over a 130 x 148 thumbnail.
                //
                // `-scale-x-100` because the capture is RAW CAMERA PIXELS and the
                // preview it was taken from is not. `.amplify-liveness-video`
                // carries `transform: scaleX(-1)` — a mirror, as every selfie
                // preview is — but a canvas grab reads the native frame and
                // ignores CSS entirely. So the stored frame is the unmirrored
                // truth, and showing it as-is hands somebody a photograph that is
                // backwards from the face they were just looking at. People do
                // not recognise themselves unmirrored; it reads as a stranger.
                //
                // Display only. `livenessResult.faceImageData` is untouched, and
                // must stay so — FaceMatchScreen posts that exact string as
                // `selfie` for the server-side comparison.
                //
                // LivenessVerdict does the same flip on the same frame. The two
                // have to agree: change one, change both.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={photo}
                    alt=""
                    className="h-148 w-130 shrink-0 -scale-x-100 rad-20 object-cover"
                />
            ) : (
                <div className="h-148 w-130 shrink-0 rad-20 bg-[#F2F2F2]" />
            )}

            <FlexSpace size={12} />

            <p className="fz-16 leading-none text-[#1D1D1D]">
                {fullName
                    ? t.rich('introGreeting', {
                          name: fullName,
                          // The name is the one part of this line that is data,
                          // so it carries the lighter weight the frame gives it.
                          person: (chunks) => (
                              <span className="font-normal text-[#707070]">{chunks}</span>
                          ),
                          hi: (chunks) => <span className="font-medium">{chunks}</span>,
                      })
                    : t('introWelcome')}
            </p>

            <FlexSpace size={12} />

            <h1 className="fz-30 leading-none font-bold text-[#1D1D1D]">{t('introTitle')}</h1>

            <FlexSpace size={12} />

            <p className="fz-14 font-medium text-[#1D1D1D]" style={{ lineHeight: rem(18) }}>
                {t('introBody')}
            </p>

            <FlexSpace size={8} />

            <p className="fz-12 font-normal text-[#707070]" style={{ lineHeight: rem(16) }}>
                {t.rich('introConsent', {
                    strong: (chunks) => (
                        <span className="font-medium text-[#1D1D1D]">{chunks}</span>
                    ),
                })}
            </p>

            <FlexSpace size={45} />

            {/* Inert — the terms document does not exist yet. */}
            <div className="flex flex-col items-center">
                <Icon name="kyc/terms" size={25} />
                <span
                    aria-disabled
                    className="fz-14 font-normal text-[#388CFF]"
                    style={{ marginTop: rem(8) }}
                >
                    {t('introTerms')}
                </span>
            </div>

            <FlexSpace size={50} share={0.17} />

            <button
                type="button"
                onClick={() => goTo('id-capture-front', 1)}
                // `relative` is what DashedFrame positions against. The fill and
                // radius live here; the outline is drawn as an SVG stroke because
                // a CSS dashed border cannot be given XD's dash and gap lengths —
                // see DashedFrame.
                className="fz-16 relative flex h-60 w-full shrink-0 items-center justify-center rad-20 bg-[#FAFAFA] font-normal text-[#3C3C3C]"
                style={{ lineHeight: rem(20) }}
            >
                <DashedFrame radius={20} color="#5D5C5D" dash={3} gap={3} size={0.5} />
                {t('introStart')}
            </button>

            {/* 12 between a button and the text link under it, everywhere. */}
            <FlexSpace size={12} />

            {/* Inert — refusing consent mid-challenge has no defined outcome. */}
            <button
                type="button"
                disabled
                className="fz-14 w-full shrink-0 cursor-not-allowed leading-none font-medium text-black"
            >
                {t('introDisagree')}
            </button>

            {/* 127 — this screen's own foot, and the exception to the flow's
                12. It is the XD value: the intro is the only screen here that
                is a page of reading rather than a control panel, and it is
                deliberately bottom-heavy. Elastic, so a short viewport takes a
                third of its shortfall from here. */}
            <FlexSpace size={127} share={0.33} />
        </div>
    );
}

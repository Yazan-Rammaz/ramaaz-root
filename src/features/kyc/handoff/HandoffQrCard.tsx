'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { CustomQRCode } from '@/components/ui/CustomQR';

const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * The hand-off QR as the frame shows it while waiting for the phone (2026-11-25):
 * the code, how to use it in three short steps, and the one thing that breaks it —
 * a VPN — said before it happens rather than after a connection that never comes.
 * Sized to fit the capture frame: the code went 200 → 170 to make room.
 */
export function HandoffQrCard({ url, onNewCode }: { url: string; onNewCode: () => void }) {
    const t = useTranslations('auth');
    const steps = [t('handoffStep1'), t('handoffStep2'), t('handoffStep3')];
    return (
        <>
            <CustomQRCode value={url} size={170} />
            <p
                className="fz-12 max-w-300 text-center leading-none font-medium text-[#1D1D1D]"
                style={{ marginTop: rem(14) }}
            >
                {t('handoffScanTitle')}
            </p>
            <ol className="flex max-w-300 flex-col" style={{ marginTop: rem(12), gap: rem(6) }}>
                {steps.map((step, i) => (
                    <li key={i} className="flex items-start text-start" style={{ gap: rem(8) }}>
                        <span
                            aria-hidden
                            className="flex shrink-0 items-center justify-center rounded-full bg-[#EAF2FF] font-medium text-[#388CFF]"
                            style={{ width: rem(16), height: rem(16), fontSize: rem(9) }}
                        >
                            {i + 1}
                        </span>
                        <span className="fz-10 text-[#707070]" style={{ lineHeight: 1.45 }}>
                            {step}
                        </span>
                    </li>
                ))}
            </ol>
            <p
                className="fz-10 max-w-300 text-center font-medium text-[#B45309]"
                style={{ marginTop: rem(10), lineHeight: 1.45 }}
            >
                {t('handoffNoVpn')}
            </p>
            {/* A fresh code. It was stop(), and the QR came back only through the idle
                restart — the moment the frame could be left empty. */}
            <button
                type="button"
                onClick={onNewCode}
                aria-label={t('handoffNewCode')}
                title={t('handoffNewCode')}
                className="text-[#707070]"
                style={{ marginTop: rem(8) }}
            >
                <Icon name="kyc/retry" size={20} mask />
            </button>
        </>
    );
}

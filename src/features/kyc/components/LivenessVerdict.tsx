'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';

/**
 * What fills the frame once the camera has stopped.
 *
 * The liveness stream ends, and from then until the backend has decided there
 * is a gap of a second or two — the session result is fetched from AWS and the
 * face compared against the enrolled selfie, both server-side. This is that gap
 * and its outcome, over a frozen frame of the user's own face.
 *
 * ── Why a still and not the live camera ─────────────────────────────────────
 * The camera is gone by this point: AWS tears its widget down when the stream
 * completes, taking the video element with it. The still is grabbed in
 * `LivenessCamera` on the last frame, for this.
 *
 * ⚠️ It is NOT the image being judged. AWS chooses the reference image from the
 * stream server-side and our Worker fetches it from them — the browser never
 * sees it, which is the property that stops a tampered client choosing who gets
 * compared. This is a picture of the same moment, shown so the user has
 * something to watch. Nothing here is measured.
 *
 * ── No text, on purpose ─────────────────────────────────────────────────────
 * Colour and motion carry all three states. That is what the design asks for,
 * and it is the version that needs no translation — but it is also why every
 * state carries an ARIA label, since none of it exists for a screen reader.
 */

/** How long the red ring holds before the face is replaced by the retry. */
const FAIL_HOLD_MS = 3000;

export type VerdictPhase = 'checking' | 'passed' | 'failed';

export function LivenessVerdict({
    phase,
    snapshot,
    onRetry,
}: {
    phase: VerdictPhase;
    /** Data URL of the last camera frame, or null if it could not be grabbed. */
    snapshot: string | null;
    /** Start again. Only reachable from the failed state. */
    onRetry: () => void;
}) {
    const t = useTranslations('auth');

    /**
     * The failure has two beats: the red ring over the face, then the face
     * replaced by a retry. Three seconds is long enough to register that it was
     * YOUR face that failed rather than the app breaking, which is the whole
     * reason for holding rather than cutting straight to the retry.
     */
    const [showRetry, setShowRetry] = useState(false);
    useEffect(() => {
        if (phase !== 'failed') return;
        const id = setTimeout(() => setShowRetry(true), FAIL_HOLD_MS);
        // Reset in the CLEANUP, not in an early return. Both undo the retry
        // when the phase moves off `failed`, but a bare `setShowRetry(false)`
        // in the effect body is a synchronous setState during render — the
        // cascading-render rule the KYC folder already carries too much of.
        return () => {
            clearTimeout(id);
            setShowRetry(false);
        };
    }, [phase]);

    const color = phase === 'failed' ? '#FF3B30' : phase === 'passed' ? '#34C759' : null;

    const label =
        phase === 'checking'
            ? t('faceChecking')
            : phase === 'passed'
              ? t('faceVerified')
              : t('faceVerifyFailed');

    return (
        <div className="absolute inset-0 overflow-hidden bg-black" role="status" aria-label={label}>
            {/* The frozen face. Mirrored to match what the camera was showing —
                the video was `scaleX(-1)`, and a picture that flips at the
                moment of capture reads as a different person's face. */}
            {snapshot && !showRetry && (
                // A plain <img>, not next/image: this is a data URL held in
                // memory, and the optimiser has nothing to fetch or resize.
                <img
                    src={snapshot}
                    alt=""
                    className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
                />
            )}

            {/* Scanning the still while the servers decide. */}
            {phase === 'checking' && (
                <span
                    aria-hidden
                    className="verdict-scan pointer-events-none absolute inset-x-0 top-0 h-64"
                />
            )}

            {/* One pulse of light out of the centre on success. */}
            {phase === 'passed' && (
                <span
                    aria-hidden
                    className="verdict-burst pointer-events-none absolute inset-0"
                />
            )}

            {/* The verdict, as the frame's own edge. */}
            {color && (
                <span
                    aria-hidden
                    className="verdict-ring pointer-events-none absolute inset-0"
                    style={{ '--verdict-color': color } as React.CSSProperties}
                />
            )}

            {/* After the hold: the face is gone and there is one thing to do. */}
            {showRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    aria-label={t('deviceRetry')}
                    className="absolute inset-0 flex items-center justify-center"
                >
                    <span className="flex h-64 w-64 items-center justify-center rounded-full bg-white/10 text-white">
                        <Icon name="kyc/retry" size={30} mask alt="" />
                    </span>
                </button>
            )}
        </div>
    );
}

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useCamera } from '@/features/kyc/hooks/useCamera';
import { createKycService } from '@/features/kyc/services';
import { useKycSession } from '@/features/kyc/context/KycSessionContext';
import { FlexSpace } from '@/components/ui/FlexSpace';
import ExitConfirmDialog from '../ExitConfirmDialog';
import faceDetectSvg from '@/features/kyc/assets/face-detect.svg';
import shieldSvg from '@/features/kyc/assets/shield.svg';

/**
 * FaceReverifyScreen — the every-login identity gate.
 *
 * Captures one live frame and asks the backend to compare it against the
 * reference photo it already holds for this admin. This is NOT `FaceMatchScreen`:
 * that one compares the live face against the photo on a freshly scanned ID and
 * only runs during first-login enrolment. This one runs on every sign-in and
 * never touches an ID.
 *
 * ── The security property that matters ──────────────────────────────────────
 * This screen decides NOTHING. It captures a frame, posts it, and waits. The
 * backend returns `{ status: 'passed', stepToken }` and the caller advances only
 * on that token. A pass/fail computed in the browser would be trivially forged
 * from devtools — and unlike rdb's in-app KYC, this sits on the login path, so
 * forging it would mean walking straight into the dashboard.
 */

type Phase = 'starting' | 'ready' | 'capturing' | 'checking' | 'failed' | 'passed';

const MAX_ATTEMPTS = 3;

export default function FaceReverifyScreen({
    challengeId,
    onPassed,
    onExhausted,
}: {
    /** Server-issued id binding this attempt to the login flow. */
    challengeId: string;
    /** Called with the server's step token — the ONLY way forward. */
    onPassed: (stepToken: string) => void;
    /** All attempts used up. */
    onExhausted: () => void;
}) {
    const router = useRouter();
    const { userData } = useKycSession();
    const kycService = useRef(createKycService());

    const { videoRef, canvasRef, isActive, error: cameraError, startCamera, stopCamera, shouldMirror, captureFrame } =
        useCamera({ facingMode: 'user' });

    const [phase, setPhase] = useState<Phase>('starting');
    const [attempts, setAttempts] = useState(0);
    const [message, setMessage] = useState('Preparing camera…');
    const [showExitDialog, setShowExitDialog] = useState(false);
    const startedRef = useRef(false);

    const firstName = userData?.user?.firstName ?? '';

    // Open the re-verify session, then the camera. The session is opened first
    // so a rejected/expired challenge fails before the user sees a camera.
    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;

        (async () => {
            try {
                await kycService.current.startReverify(challengeId);
                await startCamera();
                setPhase('ready');
                setMessage('Center your face in the frame');
            } catch (err) {
                setPhase('failed');
                setMessage(err instanceof Error ? err.message : 'Could not start verification');
            }
        })();

        return () => stopCamera();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [challengeId]);

    const runCheck = useCallback(async () => {
        setPhase('capturing');
        setMessage('Hold still…');

        const frame = captureFrame();
        if (!frame) {
            setPhase('ready');
            setMessage('Could not read the camera — try again');
            return;
        }

        setPhase('checking');
        setMessage('Checking your identity…');

        const used = attempts + 1;
        setAttempts(used);

        try {
            const result = await kycService.current.submitReverify({
                challengeId,
                liveFaceImageData: frame,
            });

            // Only a server-issued step token advances the flow.
            if (result.status === 'passed' && result.stepToken) {
                setPhase('passed');
                setMessage('Identity confirmed');
                stopCamera();
                onPassed(result.stepToken);
                return;
            }

            setPhase('failed');
            setMessage(
                result.status === 'failed'
                    ? "That doesn't match the photo on file. Face the camera in good light and try again."
                    : (result.message ?? 'Verification could not be completed'),
            );
            if (used >= MAX_ATTEMPTS) {
                stopCamera();
                onExhausted();
            }
        } catch (err) {
            setPhase('failed');
            setMessage(err instanceof Error ? err.message : 'Verification failed');
        }
    }, [attempts, captureFrame, challengeId, onPassed, onExhausted, stopCamera]);

    const borderColor =
        phase === 'passed' ? '#22C55E' : phase === 'failed' ? '#EF4444' : '#388CFF';

    const busy = phase === 'checking' || phase === 'capturing';
    const canRetry = phase === 'failed' && attempts < MAX_ATTEMPTS;

    return (
        <div className="flex flex-col h-full bg-white px-40">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => router.push('/login')}
            />

            <div className="flex absolute top-50 end-30 justify-end mb-8">
                <button
                    onClick={() => setShowExitDialog(true)}
                    className="text-red-400 hover:text-red-600"
                    aria-label="Exit verification"
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

            <FlexSpace size={100} share={0.3} />

            <h1 className="fz-30 font-bold text-center text-[#1D1D1D] mb-5">
                {firstName ? `Welcome Back, ${firstName}!` : 'Confirm Your Identity'}
            </h1>

            <div className="flex items-center justify-center gap-8 mb-11">
                <Image src={faceDetectSvg} alt="" className="object-contain w-20 h-20" />
                <span className="fz-16 font-medium text-[#1D1D1D] whitespace-nowrap">
                    Quick Face Check
                </span>
            </div>

            {/* Camera stage — mirrors FaceMatchScreen's frame so the two steps
                read as one system. */}
            <div
                className="relative mx-auto overflow-hidden rad-30 transition-colors duration-500 w-350 h-400 bg-[#E9EEEE]"
                style={{ border: `2px solid ${borderColor}` }}
            >
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="absolute inset-0 w-full h-full object-cover"
                    style={shouldMirror ? { transform: 'scaleX(-1)' } : undefined}
                />
                <canvas ref={canvasRef} className="hidden" />

                {busy && (
                    <motion.div
                        className="absolute start-0 end-0 pointer-events-none z-20"
                        style={{
                            height: '3px',
                            background:
                                'linear-gradient(90deg, transparent 0%, rgba(122,168,255,0.95) 50%, transparent 100%)',
                            boxShadow: '0 0 14px 3px rgba(122,168,255,0.7)',
                        }}
                        animate={{ top: ['0%', '100%', '0%'] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}

                {!isActive && !cameraError && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <span className="fz-12 text-[#8D8D8D]">Starting camera…</span>
                    </div>
                )}
            </div>

            <p
                className="fz-12 text-center mt-12 min-h-40"
                style={{ color: phase === 'failed' ? '#FF5F61' : '#1D1D1D' }}
                role="status"
            >
                {cameraError ?? message}
            </p>

            <FlexSpace size={90} share={0.6} />

            <div className="flex items-center flex-col justify-center gap-8 mb-12">
                <Image src={shieldSvg} alt="" className="w-15 h-15 object-contain" />
                <span className="fz-12 text-[#388CFF]">Your Privacy Is Completely Safe</span>
            </div>

            <button
                onClick={runCheck}
                disabled={busy || phase === 'passed' || (!isActive && !canRetry)}
                className="w-390 h-60 rad-20 bg-[#FCFCFC] border border-[#5D5C5D]/50 fz-16 font-medium text-[#1D1D1D] disabled:opacity-50 mb-30"
            >
                {busy ? 'Checking…' : canRetry ? `Try Again (${MAX_ATTEMPTS - attempts} left)` : 'Verify Me'}
            </button>

            <FlexSpace size={35} share={0.1} />
        </div>
    );
}

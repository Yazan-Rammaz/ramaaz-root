import type {
    IKycService,
    KycRequest,
    LivenessChallenge,
    AnalyzeIdResult,
    SubmitVerificationPayload,
    VerifyVideoPayload,
    VerifyVideoResult,
    ReverifySession,
    ReverifyPayload,
    ReverifyResult,
} from './kycService.interface';
import type { LivenessResult, IDDocument, MatchResult } from '@/features/kyc/types/verification';

/**
 * IKycService with no backend behind it.
 *
 * The real endpoints are not agreed yet (see SCENARIOS.md), but every screen in
 * this feature is finished and needs to be walked through and reviewed. This
 * implementation satisfies the whole contract locally so the flow runs
 * end-to-end in `npm run dev` — camera, liveness, ID capture and face match all
 * behave, using the operator's own captured frames as the "server" responses.
 *
 * NOTHING here talks to a network. When the real API lands, `createKycService`
 * switches back to `HttpKycService` and this file stays as the offline/demo path.
 *
 * ── Driving the failure scenarios ───────────────────────────────────────────
 * Every branch the screens can take is reachable without a backend. In the
 * browser console:
 *
 *     localStorage.setItem('kyc_mock_scenario', 'reverify-fail'); location.reload()
 *
 * See SCENARIOS.md for what each one is supposed to prove.
 */
export type MockScenario =
    | 'happy'
    | 'reverify-fail'
    | 'liveness-fail'
    | 'id-wrong-side'
    | 'id-unreadable'
    | 'match-fail'
    | 'match-review';

const SCENARIO_KEY = 'kyc_mock_scenario';

function scenario(): MockScenario {
    if (typeof window === 'undefined') return 'happy';
    return (localStorage.getItem(SCENARIO_KEY) as MockScenario | null) ?? 'happy';
}

/** Simulated round-trip, so the screens' progress animations actually play. */
const latency = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stand-in for the fields the ID reader would extract. Deliberately NOT the
 * signed-in admin's name — the summary screen is where an operator should
 * notice a mismatch, so the demo data has to be visibly someone.
 */
const EXTRACTED = {
    idType: 'National ID',
    idName: 'National ID',
    country: 'Syria',
    name: 'DANI MANSOUR',
    firstName: 'DANI',
    lastName: 'MANSOUR',
    nationalNumber: '03010123456',
    documentNumber: '03010123456',
    birthday: '1994-03-18',
    expiryDate: '2031-03-17',
} as const;

export class MockKycService implements IKycService {
    async detectFace(
        faceImageData: string,
        challengeStep: LivenessChallenge = 'look_straight',
    ): Promise<LivenessResult> {
        await latency(320);

        if (scenario() === 'liveness-fail') {
            return {
                faceImageData,
                isLive: false,
                timestamp: Date.now(),
                challengeStep,
                reason: 'not_facing_camera',
            };
        }

        return {
            faceImageData,
            isLive: true,
            timestamp: Date.now(),
            challengeStep,
            metrics: {
                yaw: challengeStep === 'turn_right' ? 28 : challengeStep === 'turn_left' ? -28 : 0,
                pitch: 1.5,
                roll: 0.4,
                brightness: 182,
                sharpness: 24,
                eyesOpen: true,
                eyesOpenConfidence: 98.2,
                sunglasses: false,
                confidence: 99.1,
            },
        };
    }

    async analyzeId(imageData: string, side: 'front' | 'back'): Promise<AnalyzeIdResult> {
        await latency(700);
        const mode = scenario();

        if (mode === 'id-wrong-side') {
            return {
                status: 'error',
                code: 'WRONG_SIDE',
                message:
                    side === 'back'
                        ? 'This is the front of your ID. Flip it over and show the back.'
                        : 'This is the back of your ID. Show the side with your photo.',
                side,
            };
        }

        if (mode === 'id-unreadable') {
            return {
                status: 'error',
                code: 'MISSING_CRITICAL_DATA',
                message: 'ID not clearly readable. Hold the card flat, well-lit, and try again.',
                side,
            };
        }

        // Echo the operator's own capture back as the "cropped" result, so the
        // summary screen shows the real card they just held up.
        if (side === 'front') {
            return {
                status: 'success',
                nextStep: 'REQUIRE_BACK',
                side,
                croppedImageData: imageData,
                idFaceImageData: imageData,
                extracted: { ...EXTRACTED },
            };
        }

        return {
            status: 'success',
            nextStep: 'COMPLETE',
            side,
            croppedImageData: imageData,
            extracted: { ...EXTRACTED },
            extractedData: { ...EXTRACTED },
        };
    }

    async captureID(imageData: string, side: 'front' | 'back'): Promise<Partial<IDDocument>> {
        await latency(400);
        return side === 'front'
            ? { ...EXTRACTED, frontImageData: imageData, idFaceImageData: imageData }
            : { ...EXTRACTED, backImageData: imageData };
    }

    async matchFaceToID(): Promise<MatchResult> {
        await latency(900);
        const mode = scenario();

        if (mode === 'match-fail') {
            return {
                isMatch: false,
                confidence: 41.6,
                verdict: 'fail',
                similarity: 41.6,
                errorMessage: 'Face does not match the photo on the ID.',
            };
        }
        if (mode === 'match-review') {
            return {
                isMatch: true,
                confidence: 87.2,
                verdict: 'review',
                similarity: 87.2,
                errorMessage: null,
            };
        }
        return {
            isMatch: true,
            confidence: 96.4,
            verdict: 'pass',
            similarity: 96.4,
            errorMessage: null,
        };
    }

    async startSession(): Promise<{ sessionId: string; expiresAt: string }> {
        await latency(200);
        return {
            sessionId: `mock-session-${Date.now()}`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        };
    }

    async submitVerification(
        payload: SubmitVerificationPayload,
    ): Promise<{ success: boolean; kycRequest?: KycRequest }> {
        await latency(800);
        return {
            success: true,
            kycRequest: {
                id: payload.kycSessionId,
                status: 'approved',
                rejectionReason: null,
                fullName: EXTRACTED.name,
            },
        };
    }

    // ── Face re-verify (the every-login gate) ────────────────────────────────

    async startReverify(): Promise<ReverifySession> {
        await latency(250);
        return { sessionId: `mock-reverify-${Date.now()}`, region: 'us-east-1', mock: true };
    }

    async submitReverify(payload: ReverifyPayload): Promise<ReverifyResult> {
        await latency(1100);

        if (scenario() === 'reverify-fail') {
            return {
                status: 'failed',
                reason: 'face_mismatch',
                faceMatchScore: 38.4,
                livenessConfidence: 97.0,
            };
        }

        return {
            status: 'passed',
            // The real server issues this; the login gate advances ONLY on it.
            stepToken: `mock-step-token-${payload.challengeId}`,
            faceMatchScore: 97.8,
            livenessConfidence: 99.2,
        };
    }

    // ── Removed video-interview step: inert stubs to satisfy the interface ───

    async startVideoCall(): Promise<{ streamUrl: string }> {
        return { streamUrl: '' };
    }

    async endVideoCall(): Promise<{ success: boolean }> {
        return { success: true };
    }

    async sendWebhook(): Promise<{ success: boolean }> {
        return { success: true };
    }

    async completeVideo(): Promise<{ success: boolean; kycRequest?: KycRequest }> {
        return { success: true };
    }

    async verifyVideo(payload: VerifyVideoPayload): Promise<VerifyVideoResult> {
        return {
            passed: true,
            nameMatch: { matches: true, confidence: 99, reasoning: 'mock' },
            ageMatch: { matches: true, confidence: 99, reasoning: 'mock' },
            face: { bestScore: 97, usedFrames: payload.faceFrames.length },
            kycStatus: 'approved',
        };
    }
}

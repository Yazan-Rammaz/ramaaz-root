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
import { api, type ApiResult } from './kycApi';

/**
 * IKycService over the HTTP API.
 *
 * Transport lives in `@/api` (`api.kyc.*`); this class is the domain layer on
 * top — it maps `ApiResult` onto the throwing contract that IKycService's
 * callers and its mock implementation share, and normalises a few response
 * shapes (see matchFaceToID and captureID).
 *
 * Five of these calls used raw `fetch`, so an access token expiring mid-flow
 * failed the step outright instead of refreshing. Going through the api client
 * gives every one of them refresh-on-401.
 */

/**
 * Unwrap a result or throw, preserving the previous error text.
 *
 * The old code threw `` `${label}: ${res.status}` `` for most calls and the
 * body's `error` field for a few. `ApiError.message` already carries the
 * server's message when there is one and falls back to a status-derived string,
 * so both cases collapse into this.
 */
function unwrap<T>(res: ApiResult<T>, label: string): T {
    if (res.ok) return res.data;
    throw new Error(`${label}: ${res.error.message}`);
}

export class HttpKycService implements IKycService {
    async detectFace(
        faceImageData: string,
        challengeStep: LivenessChallenge = 'look_straight',
        options: { crop?: boolean } = {},
    ): Promise<LivenessResult> {
        const data = unwrap(
            await api.kyc.liveness({ faceImageData, challengeStep, crop: options.crop }),
            'Liveness API error',
        );

        // Always preserve a usable image for downstream face-match: fall back to
        // the original frame when the server didn't return a crop.
        return {
            ...data,
            faceImageData: data.faceImageData ?? faceImageData,
        } as LivenessResult;
    }

    async analyzeId(
        imageData: string,
        side: 'front' | 'back',
        sessionHint = 'default',
    ): Promise<AnalyzeIdResult> {
        return unwrap(
            await api.kyc.analyzeId({ imageData, side, sessionHint }),
            'Analyze ID API error',
        );
    }

    async captureID(imageData: string, side: 'front' | 'back'): Promise<Partial<IDDocument>> {
        const result = await this.analyzeId(imageData, side);
        if (result.status !== 'success') {
            return {};
        }
        if (side === 'front') {
            const base = result.extracted ?? {};
            // The authoritative ID number after the API's passport/national-ID
            // mapping is `extractedData.documentNumber` — for a PASSPORT that is the
            // passport number (the raw `extracted` object only carries it under
            // `passportNumber`, a field IDDocument doesn't have, so it would be lost).
            // Carry it into BOTH nationalNumber and documentNumber so the downstream
            // submit always has a non-empty number for passports and national IDs alike.
            const documentNumber =
                result.extractedData?.documentNumber ||
                base.documentNumber ||
                base.nationalNumber ||
                '';
            return {
                frontImageData: result.croppedImageData || imageData,
                idFaceImageData: result.idFaceImageData,
                ...base,
                nationalNumber: base.nationalNumber || documentNumber,
                documentNumber,
            };
        }
        return {
            backImageData: result.croppedImageData || imageData,
        };
    }

    /**
     * `faceData` = live selfie crop (target). `idData` = ID-photo crop (source).
     * The argument order matches the existing IKycService contract; under the
     * hood we map them to the API's named fields so there's no ambiguity.
     */
    async matchFaceToID(faceData: string, idData: string): Promise<MatchResult> {
        const data = unwrap(
            await api.kyc.faceMatch({ idFaceImageData: idData, liveFaceImageData: faceData }),
            'Face match API error',
        );

        return {
            isMatch: data.isMatch,
            confidence:
                typeof data.confidence === 'number'
                    ? data.confidence
                    : (data.similarity ?? 0) / 100,
            similarity: data.similarity,
            verdict: data.verdict,
            errorMessage: data.errorMessage,
        };
    }

    async startVideoCall(sessionId: string): Promise<{ streamUrl: string }> {
        await new Promise((r) => setTimeout(r, 1000));
        return { streamUrl: 'mock://video-stream' };
    }

    async endVideoCall(sessionId: string): Promise<{ success: boolean }> {
        await new Promise((r) => setTimeout(r, 500));
        return { success: true };
    }

    async sendWebhook(
        userId: string,
        status: 'verified' | 'rejected',
        extractedData: Record<string, unknown>,
    ): Promise<{ success: boolean }> {
        return unwrap(
            await api.kyc.webhookNestjs({ userId, status, extractedData }),
            'Webhook API error',
        );
    }

    async startSession(): Promise<{ sessionId: string; expiresAt: string }> {
        return unwrap(await api.kyc.startSession(), 'Session start failed');
    }

    async submitVerification(
        payload: SubmitVerificationPayload,
    ): Promise<{ success: boolean; kycRequest?: KycRequest }> {
        return unwrap(await api.kyc.submit(payload), 'Submit failed');
    }

    async completeVideo(payload: {
        kycSessionId: string;
        videoCallUrl: string;
        livenessConfidence: number;
        videoVsIdScore: number;
    }): Promise<{ success: boolean; kycRequest?: KycRequest }> {
        return unwrap(await api.kyc.completeVideo(payload), 'Complete video failed');
    }

    async startReverify(challengeId: string): Promise<ReverifySession> {
        return unwrap(await api.kyc.reverifyStart({ challengeId }), 'Re-verify start failed');
    }

    async submitReverify(payload: ReverifyPayload): Promise<ReverifyResult> {
        const res = await api.kyc.reverifyVerify(payload);

        // This endpoint answers with a full verdict even on a non-2xx, so a
        // failure body is domain data rather than an error — `error.body` is
        // read instead of discarded. Only a response with no `status` at all
        // (a genuine transport/5xx failure) throws.
        const data = (res.ok ? res.data : ((res.error.body ?? {}) as Record<string, unknown>)) as
            Partial<ReverifyResult> & { error?: string };

        if (!res.ok && !data.status) {
            throw new Error(data.error ?? `Re-verify failed: ${res.error.message}`);
        }

        return {
            status: data.status ?? 'error',
            reason: data.reason,
            code: data.code,
            message: data.message ?? data.error,
            stepToken: data.stepToken,
            faceMatchScore: data.faceMatchScore,
            livenessConfidence: data.livenessConfidence,
        };
    }

    async verifyVideo(payload: VerifyVideoPayload): Promise<VerifyVideoResult> {
        return unwrap(await api.kyc.verifyVideo(payload), 'Verify video failed');
    }
}

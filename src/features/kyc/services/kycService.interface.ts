import type { LivenessResult, IDDocument, MatchResult } from '@/features/kyc/types/verification';

export type LivenessChallenge = 'look_straight' | 'turn_right' | 'turn_left';

/**
 * Structured status returned by the analyze-id API.
 *
 * - `not_found`  — No document detected in the frame; caller should keep polling.
 * - `error`      — Document detected but failed validation (see `code`).
 * - `success`    — Document detected and validated; see `nextStep` for the next action.
 */
export type AnalyzeIdStatus = 'not_found' | 'error' | 'success';

/**
 * Machine-readable error code, present when `status === 'error'`.
 *
 * - `MISSING_CRITICAL_DATA`  — Required fields (first name, DOB, document number) are
 *                              missing or below the confidence threshold.
 * - `INVALID_ID_TYPE`        — Document is not a recognised government-issued ID.
 * - `NO_TEXT_DETECTED`       — Textract found no text in the image.
 * - `WRONG_SIDE`             — Captured side doesn't match the requested side
 *                              (e.g. user shows the front during the back step).
 */
export type AnalyzeIdCode =
    | 'MISSING_CRITICAL_DATA'
    | 'INVALID_ID_TYPE'
    | 'NO_TEXT_DETECTED'
    | 'WRONG_SIDE'
    | 'SPOOFING_DETECTED';

/**
 * Next UI step, present when `status === 'success'`.
 *
 * - `REQUIRE_BACK` — Front side captured; the user must now capture the back side.
 * - `COMPLETE`     — Both sides captured; proceed to the summary / review step.
 */
export type AnalyzeIdNextStep = 'REQUIRE_BACK' | 'COMPLETE';

export interface AnalyzeIdResult {
    /** Structured status — the primary discriminant for all branching logic. */
    status: AnalyzeIdStatus;

    /** Error code — present when `status === 'error'`. */
    code?: AnalyzeIdCode;

    /** User-facing guidance message — present when `status === 'error'`. */
    message?: string;

    /** Next UI step — present when `status === 'success'`. */
    nextStep?: AnalyzeIdNextStep;

    /** Cropped document image (data URL) — present on success. */
    croppedImageData?: string;

    /** Tight crop of the ID photo — present on front-side success only. */
    idFaceImageData?: string;

    /** Which side of the ID this result describes. */
    side: 'front' | 'back';

    /**
     * Full extracted fields forwarded from `realKycService`.
     * Prefer `extractedData` for the summary UI; `extracted` is the raw
     * Partial<IDDocument> used internally.
     */
    extracted?: Partial<IDDocument>;

    /**
     * Clean 5-field payload for the confirmation UI — present when
     * `status === 'success'` and `nextStep === 'COMPLETE'`.
     */
    extractedData?: {
        idType: string;
        idName: string;
        country: string;
        name: string;
        nationalNumber: string;
        birthday: string;
        firstName?: string;
        lastName?: string;
        documentNumber?: string;
        expiryDate?: string;
        rawText?: string;
    };

    /**
     * @deprecated Use `status` / `code` instead.
     * Kept for transient backward-compatibility until all callers are updated.
     */
    found?: boolean;
    /** @deprecated Use `code` instead. */
    reason?: 'no_text_detected' | 'invalid_id_type' | 'insufficient_fields' | 'wrong_side';
}

export interface KycRequest {
    id: string;
    status: 'pending' | 'approved' | 'rejected';
    rejectionReason: string | null;
    fullName?: string;
}

export interface SubmitVerificationPayload {
    kycSessionId: string;
    frontImageData: string;
    backImageData?: string;
    selfieImageData: string;
    selfieVsIdScore: number;
    /**
     * Liveness confidence (0–100) from the face-detection step. Forwarded to
     * NestJS so it can factor liveness into the verification decision now that
     * the video step is gone. Optional for backward compatibility.
     */
    livenessConfidence?: number;
    extracted: Partial<IDDocument>;
}

export interface IKycService {
    detectFace(
        faceImageData: string,
        challengeStep?: LivenessChallenge,
        options?: { crop?: boolean },
    ): Promise<LivenessResult>;
    analyzeId(
        imageData: string,
        side: 'front' | 'back',
        sessionHint?: string,
    ): Promise<AnalyzeIdResult>;
    captureID(imageData: string, side: 'front' | 'back'): Promise<Partial<IDDocument>>;
    matchFaceToID(faceData: string, idData: string): Promise<MatchResult>;
    sendWebhook(
        userId: string,
        status: 'verified' | 'rejected',
        extractedData: Record<string, unknown>,
    ): Promise<{ success: boolean }>;
    startSession(): Promise<{ sessionId: string; expiresAt: string }>;
    submitVerification(
        payload: SubmitVerificationPayload,
    ): Promise<{ success: boolean; kycRequest?: KycRequest }>;

    /**
     * Face re-verification (step-up). Open an AWS liveness session bound to a
     * server-issued step-up `challengeId`.
     */
    startReverify(challengeId: string): Promise<ReverifySession>;
    /**
     * Submit the re-verification result. Pass `sessionId` for the AWS streaming
     * Face Liveness path, or `liveFaceImageData` for the passive single-frame path.
     * The pass/fail decision is made ONLY in NestJS.
     */
    submitReverify(payload: ReverifyPayload): Promise<ReverifyResult>;

    /**
     * First-login document enrolment. The Worker re-reads the document,
     * re-compares the faces, and commits the result to the backend over its own
     * signed channel; what comes back is the backend's verdict.
     */
    enrollDocument(payload: EnrollPayload): Promise<EnrollResult>;
}

export interface ReverifySession {
    sessionId: string;
    region: string;
    mock?: boolean;
}

export interface ReverifyPayload {
    challengeId: string;
    /** AWS Face Liveness session id (streaming path). */
    sessionId?: string;
    /** Captured straight-face frame as a data URL (single-frame path). */
    liveFaceImageData?: string;
}

/**
 * What the browser sends to enrol a document — images and a correlation id, and
 * nothing else.
 *
 * It deliberately does NOT carry the OCR result or the match score, even though
 * this client already holds both from `analyzeId` and `compareFace`. The Worker
 * re-derives them on the exact bytes it is about to sign, because a score a
 * client can choose is a score an attacker can choose — and the Worker's
 * signature is what makes the backend trust it. See kyc-submit-contract.md.
 */
export interface EnrollPayload {
    /** The 26-char ULID from the sign-in challenge. Not the challenge token. */
    challengeId: string;
    /** Data URLs. `backImage` is absent for a passport — one page. */
    frontImage: string;
    backImage?: string;
    /** The frame captured at the face step, reused rather than re-shot. */
    selfieImage: string;
    /** A hint only. Textract's own reading wins on the Worker side. */
    documentType?: string;
}

/**
 * The backend's verdict, relayed by the Worker.
 *
 * `stepToken` is the whole point: present on a pass, and the only thing that
 * may be posted to `/auth/identity-document`. Its absence is the failure.
 */
export interface EnrollResult {
    status: 'passed' | 'failed' | 'error';
    /** Why the backend refused, when `status === 'failed'`. */
    reason?: string;
    /** Machine-readable code when `status === 'error'` (bad capture, etc). */
    code?: string;
    /** User-facing message when `status === 'error'`. */
    message?: string;
    /** Single-use proof for `/auth/identity-document`. Pass only. */
    stepToken?: string;
    /** What the Worker measured, echoed for display and logs. */
    selfieVsIdScore?: number;
}

export interface ReverifyResult {
    status: 'passed' | 'failed' | 'error';
    /** Failure reason from NestJS when `status === 'failed'`. */
    reason?: string;
    /** Machine-readable error code when `status === 'error'`. */
    code?: string;
    /** User-facing message when `status === 'error'`. */
    message?: string;
    /** Step token to carry on the retried action when `status === 'passed'`. */
    stepToken?: string;
    faceMatchScore?: number;
    livenessConfidence?: number;
}

// The avatar-led video-interview step was removed. Its routes are gone from the
// KYC Worker, no screen ever called it, and it configured a product decision
// that was reversed — so the types went with it rather than lingering as a
// contract nobody implements.

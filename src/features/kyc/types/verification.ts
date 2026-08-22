/**
 * KYC state of an admin account. rdb kept this in `@/core/types/auth`; here it
 * belongs to the feature, because root identity has no KYC concept yet.
 *
 * The string VALUES are what the backend sends — confirm them against the real
 * API before going live (SCENARIOS.md §"What I need from you").
 */
export enum KycVerificationStatus {
    NOT_STARTED = 'not_started',
    PENDING = 'pending',
    VERIFIED = 'verified',
    REJECTED = 'rejected',
}

export type VerificationStep =
    | 'intro'
    /**
     * The every-login gate: capture a live face and compare it against the
     * reference photo the backend already holds. Distinct from 'face-match',
     * which compares the live face against the photo on the scanned ID.
     */
    | 'face-reverify'
    | 'id-capture-front'
    | 'id-capture-back'
    | 'id-summary'
    | 'face-detection' // MediaPipe liveness challenge + compare-face API gate
    | 'face-match'
    | 'success'
    | 'contact-support';

export interface LivenessMetrics {
    yaw: number;
    pitch: number;
    roll: number;
    brightness: number;
    sharpness: number;
    eyesOpen: boolean;
    eyesOpenConfidence: number;
    sunglasses: boolean;
    confidence: number;
    boundingBox?: { left: number; top: number; width: number; height: number };
}

export interface LivenessResult {
    faceImageData: string;
    isLive: boolean;
    timestamp: number;
    challengeStep?: 'look_straight' | 'turn_right' | 'turn_left';
    metrics?: LivenessMetrics;
    reason?: string;
}

export interface IDDocument {
    frontImageData: string;
    backImageData: string;
    /** Tight crop of the photo printed on the front of the ID, when detected. */
    idFaceImageData?: string;
    idType: string;
    idName: string;
    country: string;
    /** Combined full name. */
    name: string;
    /** First name extracted separately. */
    firstName?: string;
    /** Last name extracted separately. */
    lastName?: string;
    nationalNumber: string;
    /** Alias for nationalNumber — exposed as documentNumber for display. */
    documentNumber?: string;
    birthday: string;
    /** Expiration / expiry date. */
    expiryDate?: string;
    /** All raw text lines from Textract joined with newlines, for debugging or extra-info display. */
    rawText?: string;
}

export type FaceMatchVerdict = 'pass' | 'review' | 'fail';

export interface MatchResult {
    isMatch: boolean;
    confidence: number;
    /** 'pass' = auto-approve (≥90), 'review' = manual review (85–89), 'fail' = rejected (<85). */
    verdict?: FaceMatchVerdict;
    similarity?: number;
    errorMessage: string | null;
}

export interface VerificationSession {
    currentStep: VerificationStep;
    direction: 1 | -1;
    completedSteps: Set<VerificationStep>;
    attemptCounts: Record<string, number>;
    livenessResult: LivenessResult | null;
    idDocument: IDDocument | null;
    matchResult: MatchResult | null;
}

export interface KycServiceError {
    code: 'CAMERA_DENIED' | 'TIMEOUT' | 'SERVER_ERROR' | 'RATE_LIMITED';
    message: string;
}

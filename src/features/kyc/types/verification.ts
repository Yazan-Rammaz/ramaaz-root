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
    | 'face-match'
    | 'success'
    | 'contact-support';

/**
 * Which face check `face-reverify` runs.
 *
 * `liveness` — AWS Rekognition Face Liveness (`FaceLivenessScreen`). The real
 * check, and the default: it streams a short video and AWS decides whether a
 * live person was in front of the lens.
 *
 * `single-frame` — one captured frame compared with CompareFaces
 * (`FaceScanScreen`). Kept as a fallback for an AWS outage, and **weaker on
 * purpose to know about**: CompareFaces answers "same face" and nothing else,
 * so a photograph of the enrolled admin on a second phone passes it. That was
 * demonstrated, not theorised — it is why the liveness path exists.
 *
 * ⚠️ Only the SERVER may choose this. It is read from `KYC_FACE_MODE` in the
 * route (`faceMode()`), never derived in the browser and never selected in
 * response to AWS failing. A client-side "liveness broke, fall back" is a
 * downgrade attack: block the streaming WebSocket and you hand the attacker the
 * check the photo already defeats.
 */
export type FaceMode = 'liveness' | 'single-frame';

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

/**
 * KYC transport — the seam rdb kept at `@/api`, rebuilt for this project.
 *
 * `HttpKycService` is the domain layer; this is the layer under it that
 * actually moves bytes. It exists as its own file so that pointing this feature
 * at the real backend is a change to ONE module, not to fifteen call sites.
 *
 * ── Why these calls are same-origin ─────────────────────────────────────────
 * Every caller is a Client Component driving a camera, and this project's rule
 * is that the browser never talks to a backend directly and never holds a
 * token. So the browser calls OUR origin at `/api/kyc/*`, and a route handler
 * (`app/api/kyc/[...path]/route.ts`) attaches the auth cookie server-side and
 * forwards to the KYC service. That also keeps `connect-src 'self'` intact.
 *
 * Server Actions are deliberately NOT used here: liveness posts camera frames
 * many times per second, which is not what the RSC action protocol is for.
 *
 * ── Contract note ───────────────────────────────────────────────────────────
 * These functions NEVER throw. They return `ApiResult`, which is the shape
 * `HttpKycService.unwrap()` and every `if (!res.ok)` branch is written against.
 * A thrown error would bypass that error handling entirely.
 *
 * ── Paths ───────────────────────────────────────────────────────────────────
 * Taken from the existing ramaaz-kyc Worker, which mounts `app.route('/api/kyc',
 * kycRoutes)`. If the agreed backend differs, PATHS below is the only thing that
 * changes — see SCENARIOS.md §"What I need from you".
 */

import type { KycRequest } from './kycService.interface';

export type ApiResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: { message: string; status?: number; body?: unknown } };

/** Every endpoint this feature uses, in one table. */
export const PATHS = {
    liveness: '/api/kyc/liveness',
    analyzeId: '/api/kyc/analyze-id',
    compareFace: '/api/kyc/compare-face',
    session: '/api/kyc/session',
    status: '/api/kyc/status',
    current: '/api/kyc/current',
    submit: '/api/kyc/submit',
    webhookNestjs: '/api/kyc/webhook-nestjs',
    reverifyStart: '/api/kyc/reverify/start',
    reverifyVerify: '/api/kyc/reverify/verify',
    /**
     * Temporary AWS credentials for the Face Liveness component, gated on the
     * challenge. They are short-lived and permit exactly one action —
     * `rekognition:StartFaceLivenessSession` — because the browser has to sign
     * its own video stream to AWS and there is no server-side path for that.
     *
     * A GET with the challenge in the query string, not a POST: it reads state
     * rather than changing any, and that is how the Worker exposes it.
     */
    reverifyCredentials: '/api/kyc/reverify/credentials',
    /**
     * Document enrolment. NOT `submit` above — that is RDB's route, and it
     * needs a KYC session, a media-upload endpoint and a countries table, none
     * of which exist on root (all three answer 404). `enroll` sends the images
     * inline in one call the Worker signs. See kyc-submit-contract.md.
     */
    enroll: '/api/kyc/enroll',
} as const;

async function request<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<ApiResult<T>> {
    const { method = 'POST', body } = init;

    try {
        const res = await fetch(path, {
            method,
            // Same-origin: the httpOnly session cookie rides along, and the
            // route handler is what turns it into a backend credential.
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const payload: unknown = await res.json().catch(() => undefined);

        if (!res.ok) {
            const message =
                (payload as { message?: string; error?: string } | undefined)?.message ??
                (payload as { error?: string } | undefined)?.error ??
                `Request failed (${res.status})`;
            // `body` is load-bearing: submitReverify reads a structured 'failed'
            // verdict out of a non-2xx response rather than treating it as a
            // transport error.
            return { ok: false, error: { message, status: res.status, body: payload } };
        }

        return { ok: true, data: payload as T };
    } catch (err) {
        return {
            ok: false,
            error: { message: err instanceof Error ? err.message : 'Network error' },
        };
    }
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
const get = <T>(path: string) => request<T>(path, { method: 'GET' });

/**
 * Response shapes, as the callers actually consume them.
 *
 * These are the contract this feature needs the backend to satisfy — they are
 * the single most useful thing to check the real API against, because a
 * mismatch here is what "backend drift" looks like. Kept deliberately loose
 * where the caller is already defensive (`liveness` spreads the payload).
 */
export type LivenessResponse = { faceImageData?: string } & Record<string, unknown>;

export type FaceMatchResponse = {
    isMatch: boolean;
    confidence?: number;
    similarity?: number;
    verdict?: 'pass' | 'review' | 'fail';
    errorMessage: string | null;
};

/** What FaceMatchScreen reads straight off the wire. */
export type CompareFaceResponse = {
    status: 'success' | 'error';
    matchScore?: number;
    message?: string;
};

export type SessionResponse = { sessionId: string; expiresAt: string };
export type StatusResponse = { status?: string };
export type SubmitResponse = { success: boolean; kycRequest?: KycRequest };

export const api = {
    kyc: {
        liveness: (body: unknown) => post<LivenessResponse>(PATHS.liveness, body),
        analyzeId: <T>(body: unknown) => post<T>(PATHS.analyzeId, body),
        /** Used by httpKycService.matchFaceToID. */
        faceMatch: (body: unknown) => post<FaceMatchResponse>(PATHS.compareFace, body),
        /** Used by FaceMatchScreen directly — same endpoint, caller's own body keys. */
        compareFace: (body: unknown) => post<CompareFaceResponse>(PATHS.compareFace, body),
        startSession: () => post<SessionResponse>(PATHS.session),
        status: () => get<StatusResponse>(PATHS.status),
        current: <T>() => get<T>(PATHS.current),
        submit: (body: unknown) => post<SubmitResponse>(PATHS.submit, body),
        webhookNestjs: <T>(body: unknown) => post<T>(PATHS.webhookNestjs, body),
        reverifyStart: <T>(body: unknown) => post<T>(PATHS.reverifyStart, body),
        reverifyVerify: <T>(body: unknown) => post<T>(PATHS.reverifyVerify, body),
        reverifyCredentials: <T>(challengeId: string) =>
            get<T>(`${PATHS.reverifyCredentials}?challengeId=${encodeURIComponent(challengeId)}`),
        enroll: <T>(body: unknown) => post<T>(PATHS.enroll, body),
    },

    /**
     * UNRESOLVED — see SCENARIOS.md §3. rdb called this to write the name read
     * off the ID onto the signed-in profile. For pre-provisioned admins that is
     * probably wrong (their name is already authoritative); the useful operation
     * is to COMPARE the ID name against it. Kept only so the call site compiles.
     */
    profile: {
        update: <T>(body: unknown) => post<T>('/api/profile', body),
    },
};

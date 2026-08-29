import type { IKycService } from './kycService.interface';
import { HttpKycService } from './httpKycService';

let instance: IKycService | null = null;

/**
 * THE KYC service.
 *
 * One implementation, talking to the real KYC Worker. There is deliberately no
 * mock:
 *
 *  - A mock always says the ID is readable and the faces match, so it can prove
 *    the screens render but never the thing most likely to disappoint — how a
 *    real Syrian or Turkish ID actually reads through Textract.
 *  - Worse, it makes a broken integration look healthy. A flow that "passes"
 *    against invented data is indistinguishable from one that works.
 *
 * Three of the Worker's endpoints — `analyze-id`, `liveness` and
 * `compare-face` — need no auth, no backend and no credentials, so the whole
 * capture path is exercisable against real AWS today. The calls that reach the
 * product backend (sessions, submit, reverify) will fail until that backend
 * exists, and failing is the honest outcome: it says what is actually missing
 * instead of hiding it behind a fixture.
 *
 * Requests go to our own origin at `/api/kyc/*` and are forwarded server-side
 * by `app/api/kyc/[...path]/route.ts`, which attaches the credential. The
 * browser never holds a token (AGENTS.md §2).
 */
export function createKycService(): IKycService {
    if (!instance) instance = new HttpKycService();
    return instance;
}

/** Test seam — lets a spec inject a stub without touching module state. */
export function __setKycService(service: IKycService | null) {
    instance = service;
}

export type { IKycService } from './kycService.interface';
export { HttpKycService };

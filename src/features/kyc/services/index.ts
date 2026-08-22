import type { IKycService } from './kycService.interface';
import { HttpKycService } from './httpKycService';
import { MockKycService } from './mockKycService';

let instance: IKycService | null = null;

/**
 * THE switch between "screens only" and "wired to the real backend".
 *
 * Right now it returns the mock: the backend contract for admin KYC is not
 * agreed yet (SCENARIOS.md lists exactly what is needed), while every screen is
 * finished and needs walking through. `MockKycService` satisfies the whole
 * `IKycService` contract locally, so the flow runs end-to-end with no network.
 *
 * ── To go live, change ONE line ─────────────────────────────────────────────
 *     instance = new HttpKycService();
 *
 * `HttpKycService` is the domain layer over the transport; it still needs its
 * `api.kyc.*` calls pointed at the real endpoints (SCENARIOS.md §"What I need
 * from you"). Both classes implement the same interface, so no screen changes.
 */
export function createKycService(): IKycService {
    if (instance) return instance;
    instance = new MockKycService();
    return instance;
}

/** Test seam — lets a spec inject a stub without touching module state. */
export function __setKycService(service: IKycService | null) {
    instance = service;
}

export type { IKycService } from './kycService.interface';
export { HttpKycService, MockKycService };

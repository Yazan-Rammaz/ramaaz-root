import type { IKycService } from './kycService.interface';
import { HttpKycService } from './httpKycService';

let instance: IKycService | null = null;

/**
 * Client-facing KYC service factory.
 *
 * Calls /api/kyc/* from the browser. Those paths are forwarded by the Next
 * proxy (see `src/lib/edgeProxy.ts`) to the Cloudflare Worker in
 * `packages/kyc-server`, which owns all AWS SDK work (Textract, Rekognition)
 * and decides whether to hit real AWS or return mock data via `AWS_MOCK`.
 */
export function createKycService(): IKycService {
    if (instance) return instance;
    instance = new HttpKycService();
    return instance;
}

export type { IKycService } from './kycService.interface';

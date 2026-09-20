import 'server-only';

import { cfEnv } from '@/lib/cf-env';
import type { FaceMode } from '@/features/kyc/types/verification';

/**
 * Which face check this deployment runs — the server's decision, and only the
 * server's.
 *
 * ── Why an env var and not a backend field ──────────────────────────────────
 * Because it has to be switchable without a deploy of the other side, and the
 * remote backend's contract is not agreed yet (CLAUDE.md). When it is, the
 * honest home for this is the challenge payload alongside `stage` and
 * `challengeId` — per-tenant rather than per-worker — and this function becomes
 * the place that reads it. The call sites do not change.
 *
 * ── Turning the fallback on takes BOTH sides ────────────────────────────────
 * Setting `KYC_FACE_MODE=single-frame` here only changes which screen mounts.
 * The capture it produces is posted as `liveFaceImageData`, and the KYC Worker
 * currently REFUSES that field for the `root` tenant — deliberately, since the
 * liveness path replaced it. Flip this without re-enabling it there and the
 * admin holds still for a camera and then gets a generic failure.
 *
 * Anything other than the exact string `single-frame` means liveness, including
 * a typo. That asymmetry is the point: the weaker check is never what you get
 * by accident.
 */
export function faceMode(): FaceMode {
    return cfEnv('KYC_FACE_MODE') === 'single-frame' ? 'single-frame' : 'liveness';
}

import { DeviceStep } from '@/features/auth/components/DeviceStep';
import { requireStage } from '@/lib/auth/challenge';
import { redirectIfAuthenticated } from '@/lib/auth/guards';
import { STAGES } from '@/lib/auth/endpoints';

/**
 * Stage `DEVICE_REQUIRED` — the passkey.
 *
 * On a first login this is the last step before tokens are issued. On every
 * later login it is the FIRST, before the face — so this page is reached far
 * more often than the enrolment screens are.
 *
 * `requireStage` bounces anyone whose challenge is elsewhere, so the ceremony
 * can never be started out of order and cannot spend an attempt discovering it.
 */
export default async function DevicePage() {
    await redirectIfAuthenticated();
    await requireStage(STAGES.device);

    return <DeviceStep />;
}

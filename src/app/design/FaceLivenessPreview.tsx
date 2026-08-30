'use client';

import { FaceLivenessScreen } from '@/features/kyc/components/screens/FaceLivenessScreen';

/**
 * The gallery's wrapper for `FaceLivenessScreen`.
 *
 * It exists for one reason: `screens.tsx` is a Server Component, and a server
 * component cannot pass a function across the boundary to a client one —
 * "Event handlers cannot be passed to Client Component props". The screen needs
 * an `onSession` handler, so the handler has to be created on the client side
 * of that line. This file is that side.
 *
 * Making `onSession` optional would have been the smaller change and the wrong
 * one: in the real flow a finished liveness session with nowhere to send it is a
 * bug, and the type is what says so. A gallery convenience is not a reason to
 * weaken it.
 *
 * ⚠️ This shows the failure state, not the oval. The challenge id is a
 * placeholder, so `/reverify/start` refuses it before AWS is ever reached. The
 * oval needs a live sign-in — the entry is here so the title block, spacing and
 * failure copy can be checked at all.
 */
export function FaceLivenessPreview() {
    return (
        <FaceLivenessScreen
            challengeId="design-preview"
            onSession={async () => ({ error: 'Design gallery — no live challenge.' })}
        />
    );
}

"use client";

import { useRouter } from "next/navigation";
import { logoutAction } from "@/features/auth/actions";
import { setDocumentUnlocked } from "@/features/auth/lock-flag";
import { useSessionPasskey } from "../use-passkey-driver";
import { useUnlockVerify } from "../use-unlock";
import { PasscodeLockGate } from "./PasscodeLockGate";

/**
 * /unlock — the lock the BACKEND asked for.
 *
 * Middleware sends a page load here when the refresh answered
 * `401 PASS_CODE_REQUIRED`: the access token expired (15 minutes idle, or a
 * reload after that) and the session will not renew without the PIN. Unlike
 * the dashboard overlay, nothing is underneath — there is no access token to
 * render the page with — so this is a route, and getting the PIN right is a
 * refresh (`unlockAction`) followed by going back to where they were headed.
 *
 * It reuses the overlay's gate whole: same face, same boxes, same "Forget
 * Passcode ?" (which signs out — there is no PIN reset). The passkey unlocks
 * here too, and Add device works here as well: both are refreshes, which need
 * no access token.
 */
export function UnlockScreen({
  name,
  next,
  length,
  deviceBound,
  rpId,
}: {
  name?: string;
  next: string;
  length?: number;
  deviceBound: boolean;
  rpId?: string;
}) {
  const router = useRouter();
  const verify = useUnlockVerify();
  const passkey = useSessionPasskey({ bound: deviceBound, rpId });

  return (
    <PasscodeLockGate
      name={name}
      length={length}
      verify={verify}
      passkey={passkey}
      onUnlocked={() => {
        // The PIN was just proven, so the dashboard overlay must not ask for it
        // again on arrival — the same flag finishing sign-in sets.
        setDocumentUnlocked(true);
        router.replace(next);
      }}
      onSignOut={() => void logoutAction()}
    />
  );
}

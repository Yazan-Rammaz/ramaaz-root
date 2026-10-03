"use client";

import { IdleLock } from "@/features/auth/components/IdleLock";
import { useSessionPasskey } from "../use-passkey-driver";
import { useUnlockVerify } from "../use-unlock";
import { PasscodeLockGate } from "./PasscodeLockGate";

/**
 * The dashboard's lock, assembled: `<IdleLock>` decides WHEN, `<PasscodeLockGate>`
 * is what covers the screen, and the BACKEND judges the PIN.
 *
 * That first split is `IdleLock`'s own design — it takes the gate as a prop so
 * the challenge can be swapped without touching the timer. What it costs is this
 * file: `renderGate` is a function, the dashboard layout is a Server Component,
 * and a function cannot cross that boundary as a prop. So the pairing happens on
 * the client side of the line and the layout mounts one component.
 *
 * ── When it locks ───────────────────────────────────────────────────────────
 * On every fresh page load — a REFRESH means proving it is you before anything
 * on the dashboard can be read again — after five minutes without interaction,
 * and on demand from the navbar's lock control. All three live in `IdleLock`;
 * nothing here knows about any of them.
 *
 * ── How it unlocks ──────────────────────────────────────────────────────────
 * `unlockAction`: a refresh that carries the PIN, exactly what /unlock does. It
 * works while the access token is still valid too — the refresh token is what
 * the PIN is checked against, so a right answer simply rotates the pair early.
 * The overlay stays a UX layer over a live session (locking never signs anyone
 * out), but the PIN it asks for is now the account's, checked server-side, and
 * the same on every device. Past the access token's 15 minutes the backend
 * enforces it outright — middleware sends the page to /unlock.
 *
 * There is no "no passcode here, go and set one" branch any more: the sign-in
 * sequence sets the PIN (`PASS_CODE_REQUIRED`, SET), so every session has one.
 *
 * The passkey under the row is the link's, verified by the backend: unlocking
 * with it is the same refresh with an assertion in place of the PIN, and Add
 * device (a new passkey, behind the PIN) is a refresh carrying the new
 * credential.
 */
export function PasscodeLock({
  name,
  length,
  deviceBound,
  rpId,
}: {
  name?: string;
  length?: number;
  /** The server said a passkey is bound to this link — `root_device`. */
  deviceBound: boolean;
  /** `WEBAUTHN_RP_ID`. */
  rpId?: string;
}) {
  const verify = useUnlockVerify();
  const passkey = useSessionPasskey({ bound: deviceBound, rpId });

  return (
    <IdleLock
      renderGate={({ onUnlocked, onSignOut }) => (
        <PasscodeLockGate
          name={name}
          length={length}
          verify={verify}
          passkey={passkey}
          onUnlocked={onUnlocked}
          onSignOut={onSignOut}
        />
      )}
    />
  );
}

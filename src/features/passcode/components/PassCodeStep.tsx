"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { expireSignInAction, logoutAction, submitPassCodeAction } from "@/features/auth/actions";
import { setDocumentUnlocked } from "@/features/auth/lock-flag";
import { useSignInPasskey } from "../use-passkey-driver";
import { PasscodeLockGate, type PasscodeVerdict } from "./PasscodeLockGate";
import { SetPasscodeScreen } from "./SetPasscodeScreen";

/**
 * Stage `PASS_CODE_REQUIRED` — the last step of every sign-in while
 * `ROOT_REQUIRE_PASS_CODE` is on.
 *
 * Which screen is the BACKEND's call, read from `pass_code_mode`, never from a
 * guess about whether this is a first login:
 *
 *   SET      choose it — the two-entry screen, then one POST of the agreed PIN
 *   VERIFY   prove it — the same gate the dashboard lock uses
 *
 * Both post through `submitPassCodeAction`, which on COMPLETED stores the
 * session and returns instead of redirecting, so each screen plays its success
 * frame before leaving for the dashboard.
 */
export function PassCodeStep({
  mode,
  length,
  deviceAvailable = false,
  deviceEnrolAvailable = false,
  name,
  rpId,
}: {
  /**
   * Absent on the re-render that finishing this step causes (see the page).
   * Only the FIRST value is used — held in state below — so that render keeps
   * the screen it is replacing instead of swapping it out mid-animation.
   */
  mode?: "SET" | "VERIFY";
  length?: number;
  /** VERIFY only: the step said the link's passkey may answer instead. */
  deviceAvailable?: boolean;
  /** VERIFY only: the step said this device may be added here (Add device). */
  deviceEnrolAvailable?: boolean;
  /** `full_name` from the step — who the gate is asking. Display only. */
  name?: string;
  /** `WEBAUTHN_RP_ID`. */
  rpId?: string;
}) {
  const router = useRouter();
  const [screen] = useState(mode);
  const [digits] = useState(length);
  // Held for the same reason as `screen`: the finishing re-render passes none.
  const [bound] = useState(deviceAvailable);
  const [enrolAvailable] = useState(deviceEnrolAvailable);
  const [who] = useState(name);
  const passkey = useSignInPasskey({ bound, enrolAvailable, rpId });

  // Mounted with no mode at all: a signed-in visitor who came BACK here after
  // the sign-in finished. Nothing is owed; the dashboard is where they belong.
  useEffect(() => {
    if (!screen) router.replace("/dashboard");
  }, [screen, router]);

  async function submit(code: string): Promise<PasscodeVerdict> {
    const result = await submitPassCodeAction(code);
    if (result.ok) {
      // The PIN was just set or proven. The dashboard lock must not ask for it
      // again the moment the dashboard appears — see lock-flag.ts.
      setDocumentUnlocked(true);
      return { ok: true };
    }
    // The challenge is dead — expired or burned. No retry of this step can
    // work; /no-access is where a dead sign-in goes, and it offers the link.
    if (result.restart) await expireSignInAction();
    return { ok: false, error: result.error ?? "" };
  }

  if (!screen) return null;
  if (screen === "SET") return <SetPasscodeScreen save={submit} length={digits} />;

  return (
    <PasscodeLockGate
      name={who}
      length={digits}
      verify={submit}
      // "Use this device" when the step said `device_available` and this
      // device holds the passkey; "Add device" when it said
      // `device_enrol_available`; otherwise the control stays out of the way.
      passkey={passkey}
      onUnlocked={() => router.replace("/dashboard")}
      // No PIN reset exists: forgetting it means starting over from the link.
      onSignOut={() => void logoutAction()}
    />
  );
}

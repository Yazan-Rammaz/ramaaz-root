"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isUnlocked, relockIfReloaded } from "@/lib/auth/lock-state";

/**
 * Protected-area passcode gate. The session (authenticated) persists in a
 * cookie, but the app must be "unlocked" with the passcode after a reload.
 * Rendered in the dashboard layout: if this visit isn't unlocked, it sends the
 * user to the passcode screen. (The splash overlay hides the brief redirect.)
 */
export function PasscodeGate() {
  const router = useRouter();

  useEffect(() => {
    // Order matters: decide whether this document arrived by a real reload
    // (which re-locks) BEFORE reading the flag. Reversed, a refresh would
    // sail straight through.
    relockIfReloaded();
    if (!isUnlocked()) router.replace("/login/passcode");
  }, [router]);

  return null;
}

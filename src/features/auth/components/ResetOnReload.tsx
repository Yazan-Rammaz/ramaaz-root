"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { resetLoginFlowAction } from "../actions";

/**
 * Refreshing a half-finished sign-in starts it over.
 *
 * The login flow lives in a cookie that outlives a reload, so without this a
 * refresh would drop the admin back onto step 2 with a private code they can
 * no longer see. Clearing it and returning to /login is the honest behaviour.
 *
 * ── Deliberately NOT on the OTP or set-passcode steps ───────────────────────
 * Once a code has been sent, discarding the challenge costs a real WhatsApp
 * message and one of the three resends. An accidental F5 should not spend one,
 * so those steps keep their challenge and stay put.
 *
 * "Reload" is read from the Navigation Timing API: a genuine refresh reports
 * `reload`, while arriving by redirect or link reports `navigate` and is left
 * alone — otherwise every arrival at this step would bounce straight back.
 */
export function ResetOnReload() {
  const router = useRouter();

  useEffect(() => {
    const [entry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    if (entry?.type !== "reload") return;

    void resetLoginFlowAction().then(() => router.replace("/login"));
  }, [router]);

  return null;
}

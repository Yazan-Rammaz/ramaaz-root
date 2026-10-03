"use client";

import { useTranslations } from "next-intl";
import { setDocumentUnlocked } from "@/features/auth/lock-flag";
import { unlockAction } from "./actions";
import type { PasscodeVerdict } from "./components/PasscodeLockGate";

/**
 * The backend PIN check, as the gate wants it: `unlockAction`'s result kind
 * turned into a sentence in the reader's language.
 *
 * Shared by the two places that unlock a session after sign-in — /unlock and
 * the dashboard overlay — so they cannot drift into saying different things
 * about the same refusal.
 */
export function useUnlockVerify(): (code: string) => Promise<PasscodeVerdict> {
  const t = useTranslations("passcode");

  return async (code) => {
    const result = await unlockAction(code);
    if (result.ok) {
      // Set NOW, not when the gate's animation finishes. `unlockAction` writes
      // cookies, and a Server Action that writes cookies re-renders the page:
      // on /unlock that render finds an access token and redirects straight to
      // the dashboard, whose lock reads this flag on mount. Set any later and
      // the PIN just accepted is asked for again.
      setDocumentUnlocked(true);
      return { ok: true };
    }
    switch (result.reason) {
      case "wrong":
        return { ok: false, error: t("wrong") };
      case "rateLimited":
        return {
          ok: false,
          error: result.retryAfterSeconds
            ? t("rateLimited", { seconds: result.retryAfterSeconds })
            : t("rateLimitedUnknown"),
        };
      case "unavailable":
        return { ok: false, error: t("unavailable") };
    }
  };
}

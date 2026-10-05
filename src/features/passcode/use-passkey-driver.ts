"use client";

import { useTranslations } from "next-intl";
import {
  deviceOptionsAction,
  expireSignInAction,
  passCodeDeviceOptionsAction,
  submitPassCodeDeviceAction,
  submitPassCodeNewDeviceAction,
} from "@/features/auth/actions";
import { setDocumentUnlocked } from "@/features/auth/lock-flag";
import {
  newDeviceOptionsAction,
  refreshDeviceOptionsAction,
  registerNewDeviceAction,
  unlockWithDeviceAction,
} from "./actions";
import {
  optionsMatchThisDevice,
  runAssertion,
  runRegistration,
  type PasskeyDriver,
  type PasskeySetupOutcome,
} from "./passkey";

/**
 * The two passkey drivers — see `PasskeyDriver` for what one is. Endpoints per
 * backend bb7e4fb (change notes §3/§8).
 *
 * Both set the unlock flag the moment the SERVER accepts, not when the screen's
 * animation finishes: the actions behind them write cookies, a Server Action
 * that writes cookies re-renders the page, and that render can reach the
 * dashboard before the animation does. Same reasoning as `useUnlockVerify`.
 *
 * Both check `optionsMatchThisDevice` before opening a prompt: a device that
 * does not hold the link's passkey is offered Add device, never Chrome's QR
 * code for "a passkey from another device".
 */

/** How long a refusal may take and still be the browser's, not the person's. */
const BLOCKED_MS = 250;

/**
 * `create()` on the server's options, timed. A person takes hundreds of
 * milliseconds to read a prompt and cancel it; a browser refusing for lack of
 * user activation answers at once — and only that case is worth a "tap to
 * finish" retry.
 */
async function register(
  publicKey: Record<string, unknown>,
): Promise<Record<string, unknown> | Exclude<PasskeySetupOutcome, "ok">> {
  const startedAt = performance.now();
  const credential = await runRegistration(publicKey);
  // Checked before the clock: "already here" can come back fast, and must
  // not be mistaken for a lapsed activation.
  if (credential === "exists") return "exists";
  if (!("refused" in credential)) return credential;
  return performance.now() - startedAt < BLOCKED_MS ? "blocked" : `failed:${credential.refused}`;
}

/**
 * For a session — /unlock and the dashboard lock.
 *
 *   Use this device  /auth/refresh/device/options → get() → refresh { device }
 *   Add device       /auth/refresh/new-device/options { PIN } → create()
 *                    → refresh { new_device, label }
 *
 * Both unlock by refreshing, so both work on /unlock (no access token) as well
 * as on the dashboard lock.
 */
export function useSessionPasskey({ bound, rpId }: { bound: boolean; rpId?: string }): PasskeyDriver {
  const t = useTranslations("passcode");

  return {
    bound,
    rpId,
    async authenticate(signal, mediation, requireLocal) {
      const options = await refreshDeviceOptionsAction();
      if (!options.ok) return "unavailable";
      if (requireLocal && !optionsMatchThisDevice(options.publicKey)) return "unavailable";
      const assertion = await runAssertion(options.publicKey, signal, mediation);
      if (!assertion) return "dismissed";
      const result = await unlockWithDeviceAction(assertion);
      if (!result.ok) return "dismissed";
      setDocumentUnlocked(true);
      return "ok";
    },
    enrol: {
      async prepare(code) {
        const result = await newDeviceOptionsAction(code);
        if (result.ok) return result;
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
          case "failed":
            // The backend's code beside our sentence: readable off a phone
            // with no console, and what the backend needs to look it up.
            return {
              ok: false,
              error: result.code
                ? `${t("passkeySetupFailed")} · ${result.code}`
                : t("passkeySetupFailed"),
            };
        }
      },
      async finish(publicKey, label) {
        const credential = await register(publicKey);
        if (typeof credential === "string") return credential;
        // Binding and unlocking are one refresh. A refusal leaves the token
        // unspent and the session locked — the PIN row is the way on.
        const result = await registerNewDeviceAction(credential, label);
        if (!result.ok) {
          console.warn(`[passkey] add device refused: ${result.reason}`);
          return `failed:server ${result.reason}`;
        }
        setDocumentUnlocked(true);
        return "ok";
      },
    },
  };
}

/**
 * For the VERIFY pass-code step at sign-in.
 *
 *   Use this device  /auth/device/options → get() → /auth/device
 *                    (only when the step said `device_available`)
 *   Add device       /auth/pass-code/device/options { PIN } → create()
 *                    → /auth/pass-code/device { credential, label } → COMPLETED
 *                    (only when the step said `device_enrol_available`)
 *
 * Add device is NOT preceded by `/auth/pass-code` — that would finish the
 * sign-in with the PIN alone. The options call only checks the PIN; the
 * sign-in completes when the new credential is accepted.
 */
export function useSignInPasskey({
  bound,
  enrolAvailable,
  rpId,
}: {
  bound: boolean;
  enrolAvailable: boolean;
  rpId?: string;
}): PasskeyDriver {
  return {
    bound,
    rpId,
    async authenticate(signal, mediation, requireLocal) {
      const options = await deviceOptionsAction();
      // Only ever `authenticate` here — never run a registration this way.
      if (!options.ok || options.mode !== "authenticate" || !options.publicKey) {
        if (options.restart) await expireSignInAction();
        return "unavailable";
      }
      if (requireLocal && !optionsMatchThisDevice(options.publicKey)) return "unavailable";
      const assertion = await runAssertion(options.publicKey, signal, mediation);
      if (!assertion) return "dismissed";
      const result = await submitPassCodeDeviceAction(assertion);
      if (result.ok) {
        setDocumentUnlocked(true);
        return "ok";
      }
      // Burned the challenge — no retry of this step can work.
      if (result.restart) await expireSignInAction();
      return "dismissed";
    },
    enrol: enrolAvailable
      ? {
          async prepare(code) {
            const result = await passCodeDeviceOptionsAction(code);
            if (result.ok && result.publicKey) return { ok: true, publicKey: result.publicKey };
            if (result.restart) await expireSignInAction();
            return { ok: false, error: result.error ?? "" };
          },
          async finish(publicKey, label) {
            const credential = await register(publicKey);
            if (typeof credential === "string") return credential;
            const result = await submitPassCodeNewDeviceAction(credential, label);
            if (result.ok) {
              setDocumentUnlocked(true);
              return "ok";
            }
            // A registration that did not verify costs the challenge an
            // attempt; starting again means the options call — the PIN again.
            if (result.restart) await expireSignInAction();
            console.warn(`[passkey] add device refused: ${result.error}`);
            const why = [result.diag?.status, result.diag?.code].filter(Boolean).join(" ");
            return `failed:server ${why || "refused"}`;
          },
        }
      : undefined,
  };
}

"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { api, callerHeaders } from "@/lib/api/server";
import { env } from "@/lib/env";
import {
  clearAuthCookies,
  getRefreshToken,
  readPinLength,
  setAuthCookies,
  setDeviceHint,
} from "@/lib/auth/cookies";
import { clearChallenge, setSignInError } from "@/lib/auth/challenge";
import {
  AUTH_PATHS,
  deviceOptionsResponseSchema,
  ERROR_CODES,
  REFRESH_MAX_AGE,
  type RefreshProof,
} from "@/lib/auth/endpoints";
import { errorCode, retryAfterSeconds } from "@/lib/auth/errors";
import { refreshTokens, settledRefreshToken } from "@/lib/auth/refresh";
import {
  passcodeSchema,
  type DeviceOptionsResult,
  type UnlockResult,
} from "./schema";

/**
 * Unlock a PIN-locked session — a refresh that carries the PIN.
 *
 * ── Why a refresh, and not a "check the PIN" call ───────────────────────────
 * There is no such call. With `ROOT_REQUIRE_PASS_CODE` on, the backend's lock
 * IS the refresh: it refuses `401 PASS_CODE_REQUIRED` until the same refresh
 * token comes back with `pass_code` (change notes §8). So proving the PIN and
 * getting a fresh token pair are one request, and a wrong PIN leaves the token
 * unspent for the next try.
 *
 * It goes through `refreshTokens` rather than `api.post` for the one reason
 * that matters with single-use tokens: the single flight. Another tab's
 * middleware may be exchanging this same token right now, and two exchanges of
 * one token is TOKEN_REUSED — every session on the account revoked.
 *
 * ⚠️ The PIN is used once and forgotten. Never cached, in memory or storage: a
 * PIN the app keeps is a PIN the next reload does not ask for.
 */
export async function unlockAction(code: string): Promise<UnlockResult> {
  // The boxes cannot emit anything else, so a failure here is a tampered
  // call. Answer it as a wrong PIN rather than spend a backend attempt on it.
  if (!passcodeSchema(await readPinLength()).safeParse({ code }).success) {
    return { ok: false, reason: "wrong" };
  }
  return unlockWith({ pass_code: code });
}

/**
 * The same unlock with the link's passkey instead of the PIN — the assertion
 * from `refreshDeviceOptionsAction` → `navigator.credentials.get()`. A device
 * that does not verify answers `wrong`, exactly like a wrong PIN; the screen
 * falls back to the row.
 */
export async function unlockWithDeviceAction(
  credential: Record<string, unknown>,
): Promise<UnlockResult> {
  return unlockWith({ device: credential });
}

async function unlockWith(proof: RefreshProof): Promise<UnlockResult> {
  const refreshToken = await getRefreshToken();
  // Nothing to unlock — signed out in another tab while this one sat on the
  // lock. The splash re-checks and lands on /login.
  if (!refreshToken) redirect("/");

  const base = env.NEST_API_URL;
  if (!base) return { ok: false, reason: "unavailable" };

  const outcome = await refreshTokens(base, refreshToken, await callerHeaders(), proof);

  switch (outcome.status) {
    case "refreshed":
      await setAuthCookies(outcome.tokens);
      // A device that just verified — or was just added — is bound, and on
      // this browser.
      if ("device" in proof || "new_device" in proof) await setDeviceHint(true, REFRESH_MAX_AGE);
      return { ok: true };
    case "rejected":
    // A proof-carrying refresh answering `locked` means the proof never
    // registered as one — say "try again" rather than invent a new state.
    case "locked":
      return { ok: false, reason: "wrong" };
    case "deferred":
      return {
        ok: false,
        reason: "rateLimited",
        retryAfterSeconds: outcome.retryAfterSeconds,
      };
    case "dead":
      break;
  }

  // The session is over: revoked, spent, or "Sign in again to set your PIN"
  // (the setting was switched on after this session began and the account has
  // no PIN yet — the sign-in sequence is what sets it). Either way the way
  // forward is the access link, and /no-access is the screen that offers it.
  const t = await getTranslations("passcode");
  await clearAuthCookies();
  await clearChallenge();
  await setSignInError(outcome.message || t("sessionEnded"));
  redirect("/no-access");
}

/**
 * Ask for the passkey ceremony that unlocks this session instead of the PIN.
 *
 * Spends nothing, but it runs every check a refresh does, so it must not
 * overlap a rotation of the same token — `settledRefreshToken` waits one out
 * and hands back the replacement, which is stored here so the unlock that
 * follows reads it.
 *
 * Any refusal is `failed` and leaves the cookies alone: the PIN row is still
 * there, and this call has no business deciding the session is over.
 */
export async function refreshDeviceOptionsAction(): Promise<DeviceOptionsResult> {
  const cookieToken = await getRefreshToken();
  if (!cookieToken) redirect("/");

  const { token, rotated } = await settledRefreshToken(cookieToken);
  if (rotated) await setAuthCookies(rotated);

  try {
    const raw = await api.post<unknown>(AUTH_PATHS.refreshDeviceOptions, {
      refresh_token: token,
    });
    const { mode, publicKey } = deviceOptionsResponseSchema.parse(raw);
    // Only ever `authenticate` here. Anything else is not a ceremony this
    // screen should run.
    if (mode !== "authenticate") return { ok: false, reason: "failed" };
    return { ok: true, publicKey };
  } catch (error) {
    return optionsFailure(error);
  }
}

/**
 * ADD DEVICE on the lock screen, step 1 — open a registration behind the PIN
 * (`/v1/auth/refresh/new-device/options`, backend bb7e4fb).
 *
 * The options call IS the PIN check: a wrong one is `401 INVALID_CREDENTIALS`
 * (the backend counts it toward the lockout) and nothing starts. It does NOT
 * unlock — that is step 2, the refresh carrying the new credential. So a
 * device prompt that fails after this leaves the session locked.
 *
 * Refresh-based, so it works on /unlock as well as on the dashboard lock. Like
 * the device options call it must not overlap a rotation of the same token.
 */
export async function newDeviceOptionsAction(code: string): Promise<DeviceOptionsResult> {
  if (!passcodeSchema(await readPinLength()).safeParse({ code }).success) {
    return { ok: false, reason: "wrong" };
  }
  const cookieToken = await getRefreshToken();
  if (!cookieToken) redirect("/");

  const { token, rotated } = await settledRefreshToken(cookieToken);
  if (rotated) await setAuthCookies(rotated);

  try {
    const raw = await api.post<unknown>(AUTH_PATHS.refreshNewDeviceOptions, {
      refresh_token: token,
      pass_code: code,
    });
    const { mode, publicKey } = deviceOptionsResponseSchema.parse(raw);
    if (mode !== "register") return { ok: false, reason: "failed" };
    return { ok: true, publicKey };
  } catch (error) {
    return optionsFailure(error);
  }
}

/**
 * ADD DEVICE on the lock screen, step 2 — the refresh that carries the new
 * credential (`{ refresh_token, new_device, label }`). Success both binds the
 * passkey and unlocks, exactly like a PIN unlock; a refusal leaves the token
 * unspent. Same outcomes as `unlockAction`.
 */
export async function registerNewDeviceAction(
  credential: Record<string, unknown>,
  label: string,
): Promise<UnlockResult> {
  return unlockWith({ new_device: credential, label });
}

function optionsFailure(error: unknown): Extract<DeviceOptionsResult, { ok: false }> {
  switch (errorCode(error)) {
    case ERROR_CODES.invalidCredentials:
      return { ok: false, reason: "wrong" };
    case ERROR_CODES.rateLimited:
      return { ok: false, reason: "rateLimited", retryAfterSeconds: retryAfterSeconds(error) };
  }
  console.warn("[passkey] device options refused:", error);
  return {
    ok: false,
    reason: "failed",
    code: errorCode(error) ?? (error instanceof Error ? error.message.slice(0, 40) : undefined),
  };
}

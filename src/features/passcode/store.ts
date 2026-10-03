/**
 * What the passcode feature used to keep in the browser — now only swept.
 *
 * The PIN moved to the backend first, then the passkey, and last the portrait:
 * the backend serves the admin's photo itself (`photo_url`, read through
 * `/api/admin-photo`), so nothing here is written any more. What is left is the
 * cleanup, because a browser that ran an older build may still hold a selfie
 * in `localStorage` — a biometric nobody reads.
 */

const LEGACY_KEYS = ["root.passcode.photo.v1", "root.passcode.v1", "root.passcode.passkey.v1"];

/**
 * Remove every key the old stand-ins wrote — part of every sign-out.
 *
 * Tolerates storage that throws (Safari with site data blocked) or does not
 * exist (a server render): there is then nothing to sweep.
 */
export function sweepLegacyStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of LEGACY_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable — so nothing was ever stored in it.
  }
}

"use client";

import {
  credentialToJSON,
  deviceLabel,
  isWebAuthnAvailable,
  toPublicKeyOptions,
} from "@/lib/auth/webauthn";

/**
 * The passkey on the lock screens — Face ID, Touch ID, Windows Hello, an
 * Android fingerprint. Whatever this device calls "prove it is you".
 *
 * ── Server-verified now ─────────────────────────────────────────────────────
 * This used to be front-only: a challenge generated in this browser and a
 * signature nobody checked. It is now the backend's WebAuthn (change notes
 * §3/§8) — the SERVER issues the options (challenge, RP ID, allowed
 * credential), the browser only performs the ceremony, and the answer goes
 * back to be verified against the public key stored when the passkey was bound
 * to this link. Which endpoints depends on where the lock is; that is a
 * `PasskeyDriver`'s job (`use-passkey-driver.ts`), not this file's.
 *
 * `lib/auth/webauthn.ts` is reused for the one fiddly part — binary fields
 * crossing JSON in both directions.
 *
 * ── Where it can run at all ─────────────────────────────────────────────────
 * ⚠️ WebAuthn needs a secure context AND a real domain for the RP ID, and the
 * RP ID the backend puts in its options must match this page's host. It is
 * configured on this side as `WEBAUTHN_RP_ID` (a runtime var — see
 * `originCanHostPasskey`); the backend's own setting has to agree with it.
 * A LAN address never qualifies: `https://192.168.x.x` is a secure context but
 * an IP is not a valid RP ID. Use `localhost` or the deployed host.
 */

/**
 * What this platform calls its biometric, so the screen can name it.
 *
 * ── Why the User-Agent, of all things ───────────────────────────────────────
 * There is no API for "is this Face ID or a fingerprint". WebAuthn deliberately
 * abstracts it — `isUserVerifyingPlatformAuthenticatorAvailable()` answers
 * whether there IS one and refuses to say what. That is the right design for
 * the protocol and useless for a label, and a button that says "passkey" where
 * the phone is about to say "Face ID" is a button people do not press.
 *
 * So this is a guess from the UA, and it is a guess that only affects WORDS AND
 * AN ICON. Getting it wrong costs a slightly odd label; it cannot affect
 * whether anything works, which is the only reason UA sniffing is acceptable
 * here at all.
 */
export type PasskeyKind = "face" | "fingerprint" | "passkey";

export function passkeyKind(): PasskeyKind {
  if (typeof navigator === "undefined") return "passkey";
  const ua = navigator.userAgent;

  // iPhone and iPad: Face ID on the recent ones, Touch ID on the rest. Both are
  // "the face/finger prompt" to the person holding it, and the icon is the same
  // family — there is no way to tell which from the UA, and no need to.
  if (/iPhone|iPad|iPod/.test(ua)) return "face";
  // Apple silicon Macs and any Mac with Touch ID. Same story.
  if (/Mac OS X/.test(ua)) return "face";
  if (/Android/.test(ua)) return "fingerprint";
  // Windows Hello can be a face or a PIN depending on the hardware, so the
  // neutral name is the honest one — and it is also what Windows itself calls
  // the credential.
  return "passkey";
}

/**
 * Can a passkey exist here AT ALL — the question that decides whether the
 * control under "Forget Passcode ?" is rendered or absent.
 *
 * ⚠️ IT ASKS ONLY ABOUT THINGS NOBODY CAN FIX FROM THIS SCREEN: no WebAuthn
 * API, or an origin that cannot host the RP ID. Against either, hiding is
 * right — a control that cannot work should not be on screen.
 *
 * `isUserVerifyingPlatformAuthenticatorAvailable()` is deliberately NOT asked.
 * On Windows it means "has Windows Hello been set up", a setting on the
 * machine rather than a fact about the page — and gating visibility on it hid
 * the offer from exactly the person who most needed to discover it. The
 * ceremony meets the real state of the device, and reports a refusal.
 */
export async function isPasskeyOffered(rpId?: string): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  return originCanHostPasskey(rpId);
}

/**
 * Can a passkey exist on THIS origin at all?
 *
 * ⚠️ THIS CHECK IS NOT REDUNDANT, and leaving it out produced the worst version
 * of this feature: a button that appears, opens nothing, and reports nothing —
 * the ceremony fails with a SecurityError there is nothing useful to show
 * somebody about.
 *
 * The warnings are for whoever is wondering where the button went; this is a
 * deployment-time fact about the URL, not a user-facing condition.
 */
export function originCanHostPasskey(
  /**
   * `WEBAUTHN_RP_ID`, read server-side and handed down. When set, it is the
   * whole answer: WebAuthn accepts an RP ID only on its own host or a subdomain
   * of it, so on any other host the backend's options would fail and the
   * control is hidden instead. Unset, only the "is this a domain" check applies.
   */
  rpId?: string,
): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  // A var edited by hand picks up stray whitespace easily, and " x.dev " would
  // otherwise never equal the host.
  rpId = rpId?.trim() || undefined;

  if (rpId) {
    const ok = host === rpId || host.endsWith(`.${rpId}`);
    if (!ok) {
      console.warn(
        `[passkey] Hidden: this page is on ${host}, and WEBAUTHN_RP_ID is ` +
          `${rpId}. A passkey for that RP ID cannot be used here.`,
      );
    }
    return ok;
  }

  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return true;
  }

  // IPv4 literal, or anything bracketed (IPv6). Neither is a registrable
  // domain, so neither can be an RP ID.
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  if (isIpLiteral) {
    console.warn(
      `[passkey] Hidden: ${host} is an IP address, and WebAuthn requires a ` +
        `domain for the RP ID. Open this on http://localhost:3002 or on the ` +
        `deployed host to test it.`,
    );
    return false;
  }

  return true;
}

/* ───────────────────── which passkeys are on THIS device ───────────────────── */

/**
 * The credential ids of passkeys this browser created or used, base64url.
 *
 * ── Why it is needed at all ─────────────────────────────────────────────────
 * The server knows the LINK has passkeys (`device_available`), not which
 * device holds them — and WebAuthn will not say either: a site cannot ask "is
 * there a credential here" without starting a ceremony. Start one on a device
 * that has none, and Chrome offers "use a passkey from another device" with a
 * QR code for the old phone. That is the wrong answer for somebody on a NEW
 * device: they should set up a passkey here, not reach for the old one.
 *
 * So this browser remembers the ids it made or used, and a ceremony is started
 * only when one of them is among the credentials the server's options allow.
 *
 * Not a secret: a credential id is a public handle, useless without the
 * private key that never leaves the authenticator. It deliberately SURVIVES
 * sign-out — the passkey itself does, in the platform authenticator, and
 * forgetting its id would turn every later sign-in on this device into the QR
 * code this exists to avoid.
 */
const LOCAL_IDS_KEY = "root.passkey.ids.v1";

function readLocalIds(): string[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_IDS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberLocalId(id: unknown): void {
  if (typeof id !== "string" || !id) return;
  try {
    const ids = readLocalIds();
    if (!ids.includes(id)) {
      window.localStorage.setItem(LOCAL_IDS_KEY, JSON.stringify([...ids, id]));
    }
  } catch {
    // Blocked storage: the device just keeps being offered setup, which the
    // server answers honestly. Never worth failing a ceremony over.
  }
}

/** Has this browser ever created or used a passkey for this console? */
export function hasLocalPasskey(): boolean {
  if (typeof window === "undefined") return false;
  return readLocalIds().length > 0;
}

/**
 * Would these authentication options find a passkey on THIS device?
 *
 * When the server names the allowed credentials, one of them must be ours.
 * When it names none (a discoverable-credential request), the best available
 * answer is whether this browser has any at all.
 */
export function optionsMatchThisDevice(publicKey: Record<string, unknown>): boolean {
  const local = readLocalIds();
  if (local.length === 0) return false;
  const allowed = publicKey.allowCredentials;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.some(
    (c) => typeof (c as { id?: unknown }).id === "string" && local.includes((c as { id: string }).id),
  );
}

/**
 * Is passkey AUTOFILL available — the no-modal path?
 *
 * Separate from `isPasskeyOffered` because it is a different question with a
 * different answer: a device can have a perfectly good Face ID and a browser
 * that has never heard of conditional mediation.
 */
export async function isAutofillAvailable(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  const api = PublicKeyCredential as unknown as {
    isConditionalMediationAvailable?: () => Promise<boolean>;
  };
  if (typeof api.isConditionalMediationAvailable !== "function") return false;
  try {
    return await api.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

/**
 * Say so when the backend's RP ID cannot work on this page — the single most
 * likely reason a ceremony fails, and one the browser reports only as a bare
 * SecurityError. For whoever is testing, never for the person at the screen.
 *
 * `rp.id` on registration options, `rpId` on authentication ones.
 */
function checkRpId(publicKey: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const rp = publicKey.rp as { id?: unknown } | undefined;
  const rpId = typeof rp?.id === "string" ? rp.id : publicKey.rpId;
  const host = window.location.hostname;
  if (typeof rpId !== "string") {
    console.info(`[passkey] backend sent no RP ID; the browser will use ${host}`);
    return;
  }
  const ok = host === rpId || host.endsWith(`.${rpId}`);
  console[ok ? "info" : "warn"](
    `[passkey] backend RP ID: ${rpId} · this page: ${host}` +
      (ok ? "" : " — MISMATCH: the browser will refuse this ceremony"),
  );
}

/**
 * On Android, ask for a key bound to THIS phone rather than a synced passkey.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The backend sends `residentKey: "preferred"`. On Android that sends Chrome
 * to Google Password Manager for a SYNCED passkey — which hangs the whole setup
 * on the phone's Google account and Play services being in order. On a new
 * Android 10 device it failed outright with NotReadableError, "An unknown
 * error occurred while talking to the credential manager" (Observe, 2026-10-05).
 *
 * "discouraged" makes Chrome create a device-bound key in the phone's own
 * keystore instead: needs a screen lock, nothing else. That is also exactly
 * what Add device means — this device, its own key.
 *
 * ── Why it is safe ──────────────────────────────────────────────────────────
 *   - The backend allows it: its options say `requireResidentKey: false`, so a
 *     non-discoverable credential passes its verification. Only `residentKey`
 *     changes; the challenge and everything signed are untouched.
 *   - Every sign-in names the allowed credentials (`allowCredentials`), so a
 *     key that is not discoverable is still found.
 *
 * The one thing it costs on Android: the keyboard autofill offer lists only
 * discoverable passkeys, so it will not show this one. The prompt that opens
 * with the lock — the main path — is unaffected.
 *
 * Android only. An iPhone makes an iCloud passkey whatever is asked, and the
 * desktop path has given no trouble, so neither is touched.
 */
function deviceBoundOnAndroid(publicKey: Record<string, unknown>): Record<string, unknown> {
  if (typeof navigator === "undefined" || !/Android/i.test(navigator.userAgent)) {
    return publicKey;
  }
  const selection = (publicKey.authenticatorSelection ?? {}) as Record<string, unknown>;
  // A backend that REQUIRES a discoverable credential would reject the result,
  // so its word wins.
  if (selection.requireResidentKey === true || selection.residentKey === "required") {
    return publicKey;
  }
  return {
    ...publicKey,
    authenticatorSelection: { ...selection, residentKey: "discouraged", requireResidentKey: false },
  };
}

/**
 * Run a REGISTRATION ceremony on the server's options (`mode: "register"`).
 *
 * Needs user activation behind it: browsers require it for `create()`, and
 * quite right — nothing should be able to enrol a credential on someone's
 * device without them having asked for it. The last PIN keystroke provides it,
 * so the prompt is started the moment the PIN check answers; a browser whose
 * activation window has closed by then refuses instantly, and the screen falls
 * back to a "finish" tap.
 *
 * @returns the credential as JSON for the server; `"exists"` when this device
 * already holds a passkey for the account; otherwise `{ refused }` with the
 * browser's error name, which the screen shows beside its sentence.
 */
export async function runRegistration(
  publicKey: Record<string, unknown>,
): Promise<Record<string, unknown> | "exists" | { refused: string }> {
  if (!isWebAuthnAvailable()) return { refused: "NoWebAuthn" };
  checkRpId(publicKey);
  try {
    const credential = (await navigator.credentials.create({
      publicKey: toPublicKeyOptions(
        deviceBoundOnAndroid(publicKey),
        "register",
      ) as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null;
    if (!credential) return { refused: "NoCredential" };
    const json = credentialToJSON(credential);
    rememberLocalId(json.id);
    return json;
  } catch (error) {
    /*
     * ⚠️ SWALLOWED FOR THE USER, NEVER FOR THE DEVELOPER.
     *
     *   SecurityError   the RP ID in the server's options is not valid for this
     *                   origin — compare WEBAUTHN_RP_ID with the backend's.
     *   NotAllowedError dismissed, or no user activation behind the call.
     *   InvalidState    a credential for this account already exists here.
     */
    const { name, message } = error as Error;
    console.warn(
      `[passkey] registration failed on ${window.location.origin} — ${name}: ${message}`,
    );
    /*
     * ⚠️ InvalidStateError is NOT a failure — it is an answer. The server's
     * options exclude the link's existing credentials, and the authenticator
     * found one of them HERE. On an iPhone that is the normal case for a second
     * browser: Safari and Chrome share iCloud Keychain, so a passkey made in
     * one is already in the other — but each keeps its own localStorage, so
     * the second never learned the id and offered "Add device". Retrying
     * cannot work; using the passkey that is there does.
     */
    if (name === "InvalidStateError") return "exists";
    return { refused: name || "Error" };
  }
}

/**
 * Run an AUTHENTICATION ceremony on the server's options (`mode:
 * "authenticate"`), for the driver to send back.
 *
 * `mediation` is the difference between the two ways in:
 *
 *   optional     Safari puts up its own "Sign in with your passkey?" sheet,
 *                then Face ID. That sheet is mandatory and no site can
 *                suppress it.
 *   conditional  no sheet: the credential is offered in the keyboard's
 *                autofill bar, and choosing it goes straight to Face ID —
 *                consent the browser collected itself. Needs a field marked
 *                `autocomplete="… webauthn"` on screen (`passkeyAutofill` on
 *                <PasscodeBoxes>), and waits indefinitely, so pass a signal.
 *
 * ⚠️ `signal` is not optional in practice: React's development double-mount
 * starts every effect twice, and without aborting the first prompt it stays
 * open under the second.
 *
 * @returns the assertion as JSON, or null when dismissed or refused —
 * indistinguishable by design, so a site cannot probe for a credential.
 */
export async function runAssertion(
  publicKey: Record<string, unknown>,
  signal: AbortSignal,
  mediation: CredentialMediationRequirement = "optional",
): Promise<Record<string, unknown> | null> {
  if (!isWebAuthnAvailable()) return null;
  checkRpId(publicKey);
  try {
    const assertion = (await navigator.credentials.get({
      signal,
      mediation,
      publicKey: toPublicKeyOptions(
        publicKey,
        "authenticate",
      ) as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    if (!assertion) return null;
    const json = credentialToJSON(assertion);
    // Used here, so it lives here — covers a passkey made before this browser
    // started keeping ids, the first time it is picked some other way.
    rememberLocalId(json.id);
    return json;
  } catch {
    return null;
  }
}

/** Why an unlock attempt did not succeed — the screen reacts differently. */
export type PasskeyOutcome =
  /** Verified by the server. */
  | "ok"
  /** Dismissed, refused by the browser, or not verified by the server. */
  | "dismissed"
  /** No ceremony could be started — the server offered none. */
  | "unavailable";

/**
 * What a lock screen's passkey control runs on — one per place it appears.
 *
 * The control (`PasskeyUnlock`) owns the experience: the prompt on open when a
 * passkey is bound, a button after a dismissal, the autofill offer, the setup
 * offer. The driver owns the round trips, which differ by where the lock is:
 *
 *   sign-in (VERIFY)   /auth/device/options → get() → /auth/device
 *   /unlock, overlay   /auth/refresh/device/options → get() → refresh
 *   binding            /me/device/options {PIN} → create() → /me/device
 *                      (at sign-in, after the PIN step completes it)
 *
 * Every `authenticate` checks `optionsMatchThisDevice` before opening a prompt,
 * so a device without the passkey is offered setup instead of a QR code.
 *
 * Built in `use-passkey-driver.ts`, where the Server Actions are called.
 */
export type PasskeyDriver = {
  /** The server said a passkey is bound to this link (a hint — see DEVICE). */
  bound: boolean;
  /** `WEBAUTHN_RP_ID` — see `originCanHostPasskey`. */
  rpId?: string;
  /** Fetch options, run the ceremony, send the answer. `ok` means unlocked. */
  authenticate: (
    signal: AbortSignal,
    mediation: CredentialMediationRequirement,
    /**
     * Open a prompt only if THIS browser has used one of the allowed passkeys
     * (`optionsMatchThisDevice`). True for the automatic attempt — a new device
     * must not be shown a QR code nobody asked for. False when the person
     * TAPPED "use this device": they chose it, and a passkey made before this
     * browser kept ids is found this way (and remembered from then on).
     */
    requireLocal: boolean,
  ) => Promise<PasskeyOutcome>;
  /**
   * Binding a passkey — only where a session exists to bind it under (the
   * dashboard lock). Absent elsewhere, and no setup offer is shown.
   */
  enrol?: {
    /** The PIN check that opens a registration; a refusal is a sentence. */
    prepare: (
      code: string,
    ) => Promise<
      /**
       * `publicKey: null` — the PIN was accepted (at sign-in: the sign-in is
       * complete) but no registration could be opened. Let them in anyway.
       */
      { ok: true; publicKey: Record<string, unknown> | null } | { ok: false; error: string }
    >;
    /**
     * `create()` on those options and bind the result.
     *
     *   ok       bound.
     *   blocked  the browser refused almost instantly — no user activation left
     *            (the PIN's keystroke expired during the round trip, which some
     *            Safari builds are strict about). Offer a tap to try again.
     *   exists   this device already holds one of the link's passkeys (another
     *            browser on it made it). Use it — `authenticate` with
     *            `requireLocal: false` — rather than set up again.
     *   failed   dismissed, or refused by the browser or the server — with a
     *            short reason (`failed:NotAllowedError`, `failed:server 401
     *            CHALLENGE_INVALID`) the screen prints beside its sentence, so a
     *            failure on a phone with no console can still be read.
     */
    finish: (
      publicKey: Record<string, unknown>,
      label: string,
    ) => Promise<PasskeySetupOutcome>;
  };
};

/** What a passkey setup came to — see `PasskeyDriver.enrol.finish`. */
export type PasskeySetupOutcome = "ok" | "blocked" | "exists" | `failed:${string}`;

/**
 * The reason inside an outcome, for the screen.
 *
 * `blocked` has one too: it is a NotAllowedError the browser raised without
 * showing anything. Reaching the screen as a failure means it happened even
 * on the "finish" tap — the one case where a missing gesture is not the
 * explanation, so the name is worth showing.
 */
export function setupFailureReason(outcome: PasskeySetupOutcome): string | undefined {
  if (outcome === "blocked") return "NotAllowedError (no prompt)";
  return outcome.startsWith("failed:") ? outcome.slice("failed:".length) : undefined;
}

/** A name for the credential, shown in the device's own passkey list. */
export function passkeyLabel(name?: string): string {
  return name ? `Ramaaz Root — ${name}` : `Ramaaz Root — ${deviceLabel()}`;
}

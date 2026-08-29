/**
 * WebAuthn plumbing: JSON on the wire, ArrayBuffers in the browser.
 *
 * ── The conversion this file exists for ─────────────────────────────────────
 * The server sends `publicKey` with its binary fields — `challenge`, `user.id`,
 * and the id of every entry in `excludeCredentials` / `allowCredentials` — as
 * base64url STRINGS, because JSON has no bytes. `navigator.credentials` refuses
 * anything but `ArrayBuffer`s. The contract calls this "the most common
 * integration failure on this endpoint", and it fails with a `TypeError` that
 * names none of the above.
 *
 * No `server-only` here: this runs in the browser, which is the whole point.
 * Nothing secret passes through — a WebAuthn challenge is public by design, and
 * the credential that comes back is a public key and a signature.
 */

/* ── base64url ↔ bytes ───────────────────────────────────────────────────── */

export function b64urlToBuffer(value: string): ArrayBuffer {
    // base64url → base64, then pad: atob rejects an unpadded string.
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

export function bufferToB64url(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── options ─────────────────────────────────────────────────────────────── */

type JsonOptions = Record<string, unknown>;
type CredentialDescriptor = { id: string } & Record<string, unknown>;

/**
 * JSON options → the shape `navigator.credentials` accepts.
 *
 * Prefers the browser's own `parseCreationOptionsFromJSON` /
 * `parseRequestOptionsFromJSON` where they exist: they are the spec's answer to
 * exactly this problem and will stay correct as fields are added. The manual
 * walk below is the fallback, and it converts only the four fields that are
 * ever binary — anything else is passed through untouched, so an option this
 * code has never heard of still reaches the authenticator.
 */
export function toPublicKeyOptions(
    json: JsonOptions,
    mode: 'register' | 'authenticate',
): PublicKeyCredentialCreationOptions | PublicKeyCredentialRequestOptions {
    const native = PublicKeyCredential as unknown as {
        parseCreationOptionsFromJSON?: (j: unknown) => PublicKeyCredentialCreationOptions;
        parseRequestOptionsFromJSON?: (j: unknown) => PublicKeyCredentialRequestOptions;
    };

    if (mode === 'register' && typeof native.parseCreationOptionsFromJSON === 'function') {
        return native.parseCreationOptionsFromJSON(json);
    }
    if (mode === 'authenticate' && typeof native.parseRequestOptionsFromJSON === 'function') {
        return native.parseRequestOptionsFromJSON(json);
    }

    const opts: JsonOptions = { ...json };

    if (typeof opts.challenge === 'string') {
        opts.challenge = b64urlToBuffer(opts.challenge);
    }

    const user = opts.user as { id?: unknown } | undefined;
    if (user && typeof user.id === 'string') {
        opts.user = { ...user, id: b64urlToBuffer(user.id) };
    }

    for (const key of ['excludeCredentials', 'allowCredentials'] as const) {
        const list = opts[key] as CredentialDescriptor[] | undefined;
        if (Array.isArray(list)) {
            opts[key] = list.map((c) =>
                typeof c.id === 'string' ? { ...c, id: b64urlToBuffer(c.id) } : c,
            );
        }
    }

    return opts as unknown as PublicKeyCredentialCreationOptions;
}

/**
 * The credential → JSON for the server.
 *
 * `toJSON()` is again preferred where present. The fallback encodes both
 * response shapes because one call site handles registration and assertion:
 * `attestationObject` comes back from `create()`, and
 * `authenticatorData` / `signature` / `userHandle` from `get()`.
 */
export function credentialToJSON(credential: PublicKeyCredential): Record<string, unknown> {
    const withToJSON = credential as PublicKeyCredential & {
        toJSON?: () => Record<string, unknown>;
    };
    if (typeof withToJSON.toJSON === 'function') return withToJSON.toJSON();

    const response = credential.response as AuthenticatorResponse & {
        attestationObject?: ArrayBuffer;
        authenticatorData?: ArrayBuffer;
        signature?: ArrayBuffer;
        userHandle?: ArrayBuffer | null;
    };

    const body: Record<string, unknown> = {
        clientDataJSON: bufferToB64url(response.clientDataJSON),
    };
    if (response.attestationObject) {
        body.attestationObject = bufferToB64url(response.attestationObject);
    }
    if (response.authenticatorData) {
        body.authenticatorData = bufferToB64url(response.authenticatorData);
        if (response.signature) body.signature = bufferToB64url(response.signature);
        if (response.userHandle) body.userHandle = bufferToB64url(response.userHandle);
    }

    return {
        id: credential.id,
        rawId: bufferToB64url(credential.rawId),
        type: credential.type,
        response: body,
    };
}

/** Whether this browser can do WebAuthn at all. */
export function isWebAuthnAvailable(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof PublicKeyCredential !== 'undefined' &&
        !!navigator.credentials
    );
}

/**
 * A label for the passkey, shown in the administrator's credential list.
 *
 * Derived rather than asked for: this screen appears mid-ceremony with the
 * authenticator prompt about to open, which is the worst possible moment to put
 * a text field in front of somebody. "Chrome on Windows" is enough to recognise
 * a device in a list, and it can be renamed later from a calmer screen.
 */
export function deviceLabel(): string {
    if (typeof navigator === 'undefined') return 'Browser';
    const ua = navigator.userAgent;

    const browser = /\bEdg\//.test(ua)
        ? 'Edge'
        : /\bOPR\//.test(ua)
          ? 'Opera'
          : /\bChrome\//.test(ua)
            ? 'Chrome'
            : /\bFirefox\//.test(ua)
              ? 'Firefox'
              : /\bSafari\//.test(ua)
                ? 'Safari'
                : 'Browser';

    const os = /Windows/.test(ua)
        ? 'Windows'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad|iPod/.test(ua)
            ? 'iOS'
            : /Mac OS X/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;

    return os ? `${browser} on ${os}` : browser;
}

import { z } from "zod";

/**
 * The passcode, as typed into the boxes.
 *
 * ⚠️ The LENGTH is the backend's rule: `pass_code_length` on the
 * `PASS_CODE_REQUIRED` step, remembered after sign-in in the `root_pin_len`
 * cookie. `PASSCODE_LENGTH` is only the fallback for a session that never
 * said — never a second opinion kept in a component.
 */
export const PASSCODE_LENGTH = 6;

/** One schema, both sides (AGENTS.md §4) — for whichever length is in force. */
export function passcodeSchema(length: number = PASSCODE_LENGTH) {
  return z.object({
    code: z
      .string()
      .regex(new RegExp(`^\\d{${length}}$`), `Enter all ${length} digits`),
  });
}
export type PasscodeInput = z.infer<ReturnType<typeof passcodeSchema>>;

/**
 * What `unlockAction` answers, when it answers at all — a dead session never
 * returns: the action redirects to /no-access instead.
 *
 * `reason` is a KIND, not a sentence, so the screen can say it in the reader's
 * language (AGENTS.md §9):
 *
 *   wrong         the backend refused the PIN. The same token is still good,
 *                 so the boxes simply reset. Also what the account's PIN
 *                 lockout answers — told apart by nobody here, on purpose.
 *   rateLimited   429. Show the wait; never retry on a timer.
 *   unavailable   no backend configured. Nothing the person can fix.
 */
export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: "wrong" }
  | { ok: false; reason: "rateLimited"; retryAfterSeconds?: number }
  | { ok: false; reason: "unavailable" };

/**
 * A WebAuthn ceremony's options, fetched for the browser — or why not.
 *
 * `publicKey` is the server's JSON as-is; `lib/auth/webauthn.ts` turns it into
 * what `navigator.credentials` accepts. It is public by design (a challenge and
 * some ids), which is why it may cross to the client at all.
 *
 *   wrong        the PIN that opens an Add-device registration was refused.
 *   rateLimited  429.
 *   failed       anything else — the PIN row is still there. `code` is the
 *                backend's error code (or HTTP status), shown beside the
 *                message so a failure can be read off a phone.
 */
export type DeviceOptionsResult =
  | { ok: true; publicKey: Record<string, unknown> }
  | { ok: false; reason: "wrong" }
  | { ok: false; reason: "failed"; code?: string }
  | { ok: false; reason: "rateLimited"; retryAfterSeconds?: number };

/**
 * Where /unlock may send somebody back to: a path on THIS site and nothing
 * else. `next` arrives in a query string anyone can edit, and an unchecked one
 * turns the lock screen into an open redirect — `//evil.example` is a path to
 * a string check and a host to a browser.
 */
export function safeNextPath(raw: unknown): string {
  const fallback = "/dashboard";
  if (typeof raw !== "string" || !raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // Back to /unlock would be a lock with nowhere to go.
  if (raw === "/unlock" || raw.startsWith("/unlock?")) return fallback;
  return raw;
}

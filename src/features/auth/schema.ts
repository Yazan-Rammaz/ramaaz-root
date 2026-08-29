import { z } from "zod";

/**
 * Validation schemas are shared by the client form and the server action — one
 * definition, validated on both sides. This is the project's single validation
 * pattern: every feature exports its zod schemas here and reuses them.
 *
 * Sign-in collects exactly ONE typed value now: the private code. The password
 * and the 6-digit PIN are gone with the old protocol, and the face and passkey
 * steps collect evidence rather than text.
 */

/**
 * The private code, as issued alongside the access link (e.g. "X1D3P12").
 *
 * Deliberately unvalidated beyond "not blank". Its shape belongs to the
 * backend, and a regex here would reject a perfectly valid code the day that
 * format changes — needing a frontend release to fix something that was never
 * wrong. The server checks it either way, and that check is the real one.
 */
export const privateCodeSchema = z.object({
  code: z.string().trim().min(1, "Enter your private code"),
});
export type PrivateCodeInput = z.infer<typeof privateCodeSchema>;

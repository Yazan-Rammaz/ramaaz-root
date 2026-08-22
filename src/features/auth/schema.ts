import { z } from "zod";

/**
 * Validation schemas are shared by the client form and the server action — one
 * definition, validated on both sides. This is the project's single validation
 * pattern: every feature exports its zod schemas here and reuses them.
 *
 * Login flow (matches the XD screens): private code → password →
 * WhatsApp OTP → set passcode (first login) / passcode unlock (returning).
 */
export const privateCodeSchema = z.object({
  code: z.string().min(7, "Enter your private code").max(32),
});
export type PrivateCodeInput = z.infer<typeof privateCodeSchema>;

export const passwordSchema = z.object({
  password: z.string().min(8, "At least 8 characters").max(128),
});
export type PasswordInput = z.infer<typeof passwordSchema>;

export const otpSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, "Enter the 6-digit code"),
});
export type OtpInput = z.infer<typeof otpSchema>;

export const passcodeSchema = z.object({
  passcode: z.string().regex(/^[0-9]{6}$/, "Enter a 6-digit passcode"),
});
export type PasscodeInput = z.infer<typeof passcodeSchema>;

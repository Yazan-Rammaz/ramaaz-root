/**
 * Announced when a fresh OTP has been sent.
 *
 * <ResendTimer> and <VerifyStep> are siblings inside the verify page, so the
 * resend tells the code input to drop its stale "wrong code" message through a
 * window event rather than threading state up through the page for one string.
 */
export const OTP_RESENT_EVENT = "root:otp-resent";

export function announceOtpResent(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OTP_RESENT_EVENT));
}

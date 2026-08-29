import "server-only";
import { z } from "zod";
import { api } from "@/lib/api/server";
import {
  applyStage,
  clearChallenge,
  sessionLabel,
  UnknownStageError,
} from "@/lib/auth/challenge";
import {
  AUTH_PATHS,
  linkTokenSchema,
  stepResponseSchema,
  type LinkRequest,
} from "@/lib/auth/endpoints";
import { signInError } from "@/lib/auth/errors";

/**
 * Step 1 — open the access link.
 *
 * Not a Server Action: the only caller is the `/enter/[token]` Route Handler,
 * and exporting it from a "use server" module would publish it as an endpoint
 * the browser can POST to. That would not leak anything (visiting the link does
 * the same thing) but it would be a second way in to maintain, and the flow
 * already has one.
 *
 * The token travels in the BODY. Never build a URL of our own around it: a path
 * segment lands in access logs, proxy logs and browser history, and this token
 * is reused for the life of the link.
 */
export async function openLink(rawToken: string): Promise<{ error: string }> {
  const parsed = linkTokenSchema.safeParse({ token: rawToken });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That link is not valid" };
  }

  let result;
  try {
    // A link always begins a FRESH sequence. Any half-finished challenge still
    // sitting in the cookie belongs to a previous attempt, and leaving it would
    // let a failure here fall through to a screen from the old one.
    await clearChallenge();

    const raw = await api.post<unknown>(AUTH_PATHS.link, {
      token: parsed.data.token,
      device_label: await sessionLabel(),
    } satisfies LinkRequest);

    result = stepResponseSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: "Unexpected response from the sign-in service" };
    }
    if (error instanceof UnknownStageError) {
      return { error: error.message };
    }
    // Every refusal here answers UNAUTHENTICATED and they are deliberately
    // indistinguishable — unknown link, revoked, expired, out of its address
    // range or country, or a suspended account. One message, no speculation.
    return {
      error: signInError(error, "That access link cannot be opened."),
    };
  }

  // Outside the try: applyStage() redirects, and redirect() signals by
  // throwing, so calling it inside would be caught above and the navigation
  // silently swallowed.
  return applyStage(result);
}

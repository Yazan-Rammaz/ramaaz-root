import "server-only";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api, ApiError } from "@/lib/api/server";
import {
  applyStage,
  challengeIsLive,
  clearChallenge,
  readChallenge,
  sessionLabel,
  UnknownStageError,
} from "@/lib/auth/challenge";
import {
  AUTH_PATHS,
  linkTokenSchema,
  stepResponseSchema,
  STAGE_ROUTES,
  type LinkRequest,
} from "@/lib/auth/endpoints";
import { correlationId, signInError } from "@/lib/auth/errors";

/**
 * Step 1 — open the access link.
 *
 * Not a Server Action, and still not one now that it has two callers — the
 * `/enter/[token]` Route Handler, and `restartSignInAction`, which re-opens the
 * stored link when a challenge has burned. Exporting it from a "use server"
 * module would publish it as an endpoint the browser can POST to. That would not
 * leak anything (visiting the link does the same thing) but it would be a way in
 * that nothing needs, and both callers already reach it as a plain function.
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

  // Read BEFORE the call, and do not clear yet — see the failure path below.
  const existing = await readChallenge();


  // ── Re-opening the same link is free ──────────────────────────────────────
  //
  // THE fix for "it worked once, then every refresh said access denied".
  //
  // If this browser is already holding a live challenge that THIS link opened,
  // there is nothing to ask the backend. Asking anyway is what caused the
  // refusal: /auth/link opens a sequence, so a second open of a link already in
  // flight is a request the server is entitled to reject — and every reject
  // landed on /no-access. So the second open simply does not happen. The
  // administrator is put back exactly where they were.
  //
  // That makes the URL idempotent for its whole 10-minute life, which is what
  // anybody tapping a link in a chat app reasonably expects: refresh, back
  // button, tapping the message again, the in-app browser reloading on resume —
  // all of them now land on the current step instead of a wall.
  //
  // Three conditions, all necessary:
  //   - SAME link. A different token must open its own challenge, or one link
  //     could ride another's sequence.
  //   - STILL LIVE. Past its deadline there is nothing to resume, so fall
  //     through and let a genuine open either succeed or be refused honestly.
  //   - A STAGE WE HAVE A SCREEN FOR. Otherwise there is nowhere to send them.
  if (existing.linkToken === parsed.data.token && challengeIsLive(existing)) {
    const here = STAGE_ROUTES[existing.stage ?? ""];
    if (here) redirect(here);
  }

  let result;
  try {
    const raw = await api.post<unknown>(AUTH_PATHS.link, {
      token: parsed.data.token,
      device_label: await sessionLabel(),
    } satisfies LinkRequest);

    result = stepResponseSchema.parse(raw);
  } catch (error) {
    // ⚠️ NOTHING is cleared here, and that is the point.
    //
    // This used to clear the challenge BEFORE the request, on the reasoning
    // that a link always begins a fresh sequence. It does — but only when the
    // request SUCCEEDS. Re-opening the link is the first thing anybody does
    // when a step misbehaves, and clearing first meant that tap destroyed a
    // perfectly live challenge and then, if the second open was refused, left
    // them with nothing: every screen reads a missing cookie and sends them to
    // /no-access. An administrator halfway through a sign-in was one stray tap
    // from being locked out of their own attempt, and the screen told them they
    // had no access when what they had was no cookie.
    //
    // A refused re-open is therefore inert now: the attempt in progress
    // survives it, and they are put back where they were.
    //
    // ApiError ONLY — the backend answered, and said no. A ZodError or an
    // UnknownStageError means it answered something we could not read, in which
    // case the link probably DID open and the challenge we are still holding is
    // stale server-side. Bouncing to its stage would walk them into a step the
    // server has already moved past, so those fall through and are reported.
    //
    // `challengeIsLive` and not merely "has a token": with the short-circuit
    // above in place, the only way to reach here still holding a challenge is
    // that it belongs to a DIFFERENT link, or that it has expired. Rescuing an
    // expired one would drop the administrator onto a step whose every request
    // the server will refuse — a slower, more confusing version of the wall
    // this is meant to remove.
    if (error instanceof ApiError && challengeIsLive(existing)) {
      const back = STAGE_ROUTES[existing.stage ?? ""];
      if (back) redirect(back);
    }

    if (error instanceof z.ZodError) {
      return { error: "Unexpected response from the sign-in service" };
    }
    if (error instanceof UnknownStageError) {
      return { error: error.message };
    }

    // Retained Worker logs (see wrangler.jsonc `observability`) are the only
    // record of WHICH refusal this was — the screen deliberately cannot say,
    // and the correlation id is what support traces backend-side. Without this
    // a failed sign-in leaves no evidence anywhere that anyone can read.
    console.warn("[auth/link] refused", {
      correlation_id: correlationId(error),
      status: error instanceof ApiError ? error.status : undefined,
      detail: error instanceof Error ? error.message : String(error),
    });

    // Every refusal here answers UNAUTHENTICATED and they are deliberately
    // indistinguishable — unknown link, revoked, expired, out of its address
    // range or country, or a suspended account. One message, no speculation.
    return {
      error: signInError(error, "That access link cannot be opened."),
    };
  }

  // The new sequence is real, so the old one may go. Clearing here rather than
  // before the call is what makes a failed open harmless; `applyStage` writes
  // the replacement cookie immediately below, so nothing is ever left empty.
  await clearChallenge();

  // Outside the try: applyStage() redirects, and redirect() signals by
  // throwing, so calling it inside would be caught above and the navigation
  // silently swallowed.
  //
  // The link token is stored HERE, the one place that knows which link this
  // is. From here on every step carries it forward, which is what keeps both
  // the re-open short-circuit above and "start over" working for the rest of
  // the sequence.
  return applyStage(result, parsed.data.token);
}

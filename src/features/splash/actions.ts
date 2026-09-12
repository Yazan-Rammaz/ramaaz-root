"use server";

import { getSession } from "@/lib/auth/session";
import { sessionHome } from "@/lib/auth/guards";

/**
 * Resolves where the splash should send the user. Runs the authoritative
 * session check (BFF `/v1/me`) server-side, so no token/identity logic ever
 * reaches the client. The splash calls this on mount, concurrently with its
 * minimum-display timer. Any failure (e.g. backend unreachable) → login.
 *
 * A signed-in admin goes straight to where they belong — no passcode stop.
 * The passcode is now an idle lock inside the dashboard, not a checkpoint on
 * the way in, so sending them via a passcode route would be asking for a
 * credential they have already proven.
 */
export async function resolveEntry(): Promise<string> {
  try {
    const session = await getSession();
    return session ? sessionHome(session) : "/login";
  } catch {
    return "/login";
  }
}

/*
 * ── Why this is live again ──────────────────────────────────────────────────
 *
 * This was commented out to a hard-coded "/login" while `GET /v1/me` was dead —
 * `getSession()` called it, so the check could only ever fail and the branch was
 * dead weight. That reasoning was sound at the time.
 *
 * It no longer holds: `getSession()` makes NO network call. It reads the access
 * cookie and the user snapshot written at sign-in (see lib/auth/session.ts), so
 * nothing here depends on the missing endpoint.
 *
 * And with the fix in place the stub actively hurts. Returning "/login"
 * unconditionally sends a SIGNED-IN administrator to the sign-in screen, which
 * finds no challenge and forwards them to /no-access — so "/" became a dead end
 * for exactly the people who had already got in.
 */

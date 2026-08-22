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

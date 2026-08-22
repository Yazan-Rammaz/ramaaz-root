"use server";

import { getSession } from "@/lib/auth/session";

/**
 * Resolves where the splash should send the user. Runs the authoritative
 * session check (BFF `/auth/me`) server-side, so no token/identity logic ever
 * reaches the client. The splash calls this on mount, concurrently with its
 * minimum-display timer. Any failure (e.g. backend unreachable) → login.
 */
export async function resolveEntry(): Promise<"/dashboard" | "/login/passcode" | "/login"> {
  try {
    const session = await getSession();
    // Authenticated users re-prove the passcode on every fresh load; the
    // client-side lock (lock-state.ts) is what <PasscodeGate> checks after.
    return session ? "/login/passcode" : "/login";
  } catch {
    return "/login";
  }
}

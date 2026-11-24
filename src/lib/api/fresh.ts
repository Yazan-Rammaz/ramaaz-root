import "server-only";
import { cookies, headers } from "next/headers";

/*
 * When a kept read (`readShared`, `readMe`) may be used (2026-11-24).
 *
 * 1. A full page load — a refresh, the address bar, a new tab — always reads
 *    fresh: the browser marks it `Sec-Fetch-Dest: document`. Moving between pages
 *    inside the console (a client navigation) and Server Actions use what was kept.
 *    ⚠️ Not the `RSC` header: Next deletes it before `headers()` (FLIGHT_HEADERS,
 *    request-store.js), so every request looked like a full load and nothing kept
 *    was ever used — measured 2026-11-24, the head office opening in ~5 s.
 * 2. After any write, this browser carries the time of it (`rz_fresh`, httpOnly),
 *    and nothing kept before that time is used. The Worker runs as several
 *    isolates, each with its own memory: clearing the one that saved is not
 *    enough, the next click may land on another. The cookie travels with the
 *    person, so every isolate sees it.
 */
const FRESH = "rz_fresh";

/** After a write: what was kept before now is not used again, by any isolate. */
export async function markWritten(): Promise<void> {
  try {
    (await cookies()).set(FRESH, String(Date.now()), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
  } catch {
    // Only Server Actions and route handlers may set a cookie; every write runs in one.
  }
}

/** Kept values made at or before this moment are not used; Infinity on a full page load. */
export async function keptAfter(): Promise<number> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  if (h.get("sec-fetch-dest") === "document") return Infinity;
  return Number(c.get(FRESH)?.value) || 0;
}

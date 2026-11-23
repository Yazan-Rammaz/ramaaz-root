import "server-only";
import { cache } from "react";
import { api } from "@/lib/api/server";
import { getAccessToken } from "@/lib/auth/cookies";
import { keptAfter } from "@/lib/api/fresh";
import { AUTH_PATHS } from "@/lib/auth/endpoints";

/*
 * THE `GET /v1/me` read (2026-11-24).
 *
 * Every page change asked it twice, one after the other — once for the session
 * gate (`readSession`), once for the selected project (`listRegistry`) — at
 * 0.25–1 s each on staging, before the page could render. Now one read per
 * request, shared by both (`cache`), and kept for a few seconds across requests
 * so moving between pages does not ask again at all.
 *
 * Keyed on the ACCESS TOKEN: a different person, a new sign-in or a PIN unlock
 * (which rotates the token) is a new key, so nobody is ever served another
 * session's answer. A failed read is not kept. In this Worker isolate's memory
 * only.
 */
const ME_MS = 20_000;
const recent = new Map<string, { at: number; until: number; value: Promise<unknown> }>();

export const readMe = cache(async (): Promise<unknown> => {
  const token = await getAccessToken();
  const [since, now] = [await keptAfter(), Date.now()];
  if (token) {
    const hit = recent.get(token);
    // Not after a refresh, nor after a write by this browser (see keptAfter).
    if (hit && hit.until > now && hit.at > since) return hit.value;
  }
  for (const [k, v] of recent) if (v.until <= now) recent.delete(k);
  const value = api.get<unknown>(AUTH_PATHS.me);
  if (token) {
    recent.set(token, { at: now, until: now + ME_MS, value });
    value.catch(() => recent.delete(token));
  }
  return value;
});

/** After a write that changes what `/v1/me` says (a project selected, grants changed): read it fresh. */
export function forgetMe(): void {
  recent.clear();
}

"use client";

import { useEffect, useState } from "react";

/**
 * TEMPORARY dev helper: fetch a freshly minted admin's credentials so the login
 * screens can fill themselves in.
 *
 * Lives outside `components/` on purpose. UI components are barred from calling
 * `fetch` (eslint `no-restricted-syntax`) because data belongs in a Server
 * Action or a feature api module. This is neither — it is throwaway dev
 * tooling, and Server Actions were explicitly ruled out for it — so it is kept
 * as its own module rather than smuggled into a component and silenced.
 *
 * ── Turning it off ─────────────────────────────────────────────────────────
 * NEXT_PUBLIC_DEV_AUTOFILL=0 in .env.local, then restart `npm run dev`. The
 * hook then never fetches and returns null forever, and the route it calls
 * 404s on the same flag.
 */

const STORAGE_KEY = "dev_autofill_credentials";
const ENABLED = process.env.NEXT_PUBLIC_DEV_AUTOFILL === "1";

export type DevCredentials = {
  privateCode: string;
  password: string;
  phone: string | null;
};

/**
 * Module-scoped so EVERY caller shares one request.
 *
 * This is load-bearing, not a micro-optimisation: the endpoint behind it
 * deletes and recreates the root admin on each call. React StrictMode invokes
 * effects twice in development, and the private-code and password screens both
 * ask for credentials — without this, a single page load would reset the admin
 * two or three times over, each reset invalidating the previous one's token.
 */
let inflight: Promise<DevCredentials | null> | null = null;

async function load(fresh: boolean): Promise<DevCredentials | null> {
  // `fresh` skips the cache so landing on the private-code screen always mints
  // a NEW admin with an unspent invitation token. The cached path exists for
  // the password screen, which must reuse what step 1 minted — asking for its
  // own would reset the admin again and invalidate the code already on screen.
  if (!fresh) {
    const cached = sessionStorage.getItem(STORAGE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as DevCredentials;
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch("/api/dev/reset", { method: "POST" });
        if (!res.ok) return null;
        const data = (await res.json()) as DevCredentials;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return data;
      } catch {
        return null;
      } finally {
        // Cleared so a later session (after clearing storage) can retry.
        inflight = null;
      }
    })();
  }

  return inflight;
}

/**
 * The minted credentials, or null while loading / when disabled.
 *
 * @param fresh Mint a NEW admin instead of reusing the cached one. The
 *   private-code screen passes true (every visit starts a clean registration
 *   with an unspent token); the password screen passes false so it reuses what
 *   step 1 just minted.
 */
export function useDevCredentials(fresh = false): DevCredentials | null {
  const [credentials, setCredentials] = useState<DevCredentials | null>(null);

  useEffect(() => {
    if (!ENABLED) return;
    let alive = true;
    // Async so nothing sets state synchronously inside the effect body.
    void load(fresh).then((c) => {
      if (alive && c) setCredentials(c);
    });
    return () => {
      alive = false;
    };
  }, [fresh]);

  return credentials;
}

/** Whether the temporary autofill is switched on at all. */
export const DEV_AUTOFILL_ENABLED = ENABLED;

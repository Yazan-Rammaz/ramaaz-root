"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { resolveEntry } from "../actions";

/**
 * The "/" entry has no content of its own — it decides where to send the user.
 * Runs the auth check (server action) and replaces the URL with /dashboard or
 * /login. The <SplashGate> on this same route covers the hop, so the user
 * only ever sees the splash until it fades onto the destination.
 */
export function EntryRedirect() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    resolveEntry()
      .then((target) => {
        if (active) router.replace(target);
      })
      .catch(() => {
        if (active) router.replace("/login");
      });
    return () => {
      active = false;
    };
  }, [router]);

  return null;
}

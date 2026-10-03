"use client";

import { useEffect, useState } from "react";

/**
 * The admin's photo for the PIN and lock screens, or null.
 *
 * ── From the backend, through our own origin ────────────────────────────────
 * `/api/admin-photo` resolves the backend's `photo_url` server-side — from the
 * sign-in challenge, `/v1/me`, or the session snapshot, whichever is current
 * (see that route). It takes no parameters, so this cannot ask for anybody's
 * picture but the caller's own.
 *
 * ── Fetched once, held as a blob URL ────────────────────────────────────────
 * The avatar draws the picture twice — the image and the glass pane's filtered
 * copy of it (`PhotoGlass`). Pointing both at the route would fetch it twice,
 * and each fetch is a `/v1/me` call plus a download, since the route must not
 * be cached. One fetch into a `blob:` URL (allowed by `img-src`) serves both.
 *
 * Null until it arrives, and null for good on any miss — no photo on the
 * account, an expired signature, a network blip. The caller shows the avatar
 * glyph then; a missing picture never blocks anything.
 */
export function useAdminPhoto(): string | null {
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch("/api/admin-photo", { cache: "no-store" });
        const type = res.headers.get("content-type") ?? "";
        // Checked, not assumed: anything but an image is a miss.
        if (!res.ok || !type.startsWith("image/")) return;
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPhoto(url);
      } catch {
        // Decoration — the glyph stays.
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  return photo;
}

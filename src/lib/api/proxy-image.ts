import "server-only";
import { NextResponse } from "next/server";

/**
 * Stream an image the BACKEND pointed us at, from our own origin.
 *
 * For the photo routes (`/api/face-capture`, `/api/admin-photo`). The browser
 * cannot load these URLs itself: it never addresses a backend (AGENTS.md §2),
 * and `img-src 'self' data: blob:` would refuse the request anyway.
 *
 * ⚠️ Only ever call it with a URL the server chose — one read from an httpOnly
 * cookie or a backend response, never from the request. A handler that fetched
 * whatever it was handed would be an open proxy wearing this app's origin.
 *
 * Every miss is a 404, not a 403 or a 502: whether some account has a picture
 * is not the caller's business, and the screens read a miss as "show the
 * avatar glyph".
 */
export async function proxyImage(url: string | undefined, label: string): Promise<Response> {
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!url) return notFound();

  let upstream: Response;
  try {
    upstream = await fetch(url, { cache: "no-store" });
  } catch (error) {
    console.error(`[${label}] fetch failed:`, error);
    return notFound();
  }

  if (!upstream.ok || !upstream.body) {
    // A signed URL past its expiry lands here (403 from S3).
    console.warn(`[${label}] upstream said`, upstream.status);
    return notFound();
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      // A face, tied to one person. No shared cache may hold it, and the
      // browser must not serve it to the next account from memory.
      "Cache-Control": "no-store, private",
    },
  });
}

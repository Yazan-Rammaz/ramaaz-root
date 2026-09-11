import { NextResponse } from "next/server";
import { readChallenge } from "@/lib/auth/challenge";

/**
 * The face captured earlier in THIS sign-in, served from our own origin.
 *
 * ── Why a proxy and not the URL ─────────────────────────────────────────────
 * `face_capture_url` points at the backend. Two independent reasons the browser
 * cannot simply load it:
 *
 *  1. The browser never addresses a backend directly (AGENTS.md §2). That rule
 *     does not get an exception for images.
 *  2. It would not work anyway — `img-src 'self' data: blob:` in the CSP means
 *     the request is refused before it is made.
 *
 * So the URL stays server-side and the bytes come from here. Nothing about the
 * backend's storage reaches the page.
 *
 * ── It takes no parameters, deliberately ────────────────────────────────────
 * The URL is read from the CHALLENGE COOKIE, not from a query string. A handler
 * that fetched whatever URL it was handed would be an open proxy wearing this
 * app's origin — anyone could point it anywhere, from our IP, past our CSP.
 * Taking no input at all makes that impossible rather than merely guarded
 * against: the only image this can ever return is the one belonging to the
 * sign-in whose cookie the caller already holds.
 */

// A per-request read of an httpOnly cookie — never prerendered, never cached.
export const dynamic = "force-dynamic";

export async function GET() {
  const { faceCaptureUrl } = await readChallenge();

  // 404, not 403: whether a sign-in in some other browser has a stored face is
  // not this caller's business, and the screens treat a miss as "no photo yet".
  if (!faceCaptureUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(faceCaptureUrl, { cache: "no-store" });
  } catch (error) {
    console.error("[face-capture] fetch failed:", error);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!upstream.ok || !upstream.body) {
    console.warn("[face-capture] upstream said", upstream.status);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      // A face, tied to one sign-in. No shared cache may hold it, and the
      // browser must not serve it to the next challenge from memory.
      "Cache-Control": "no-store, private",
    },
  });
}

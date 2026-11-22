import { z } from "zod";
import { api } from "@/lib/api/server";
import { AUTH_PATHS } from "@/lib/auth/endpoints";
import { proxyImage } from "@/lib/api/proxy-image";
import { readChallenge, writeChallenge } from "@/lib/auth/challenge";

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
 *
 * ── An expired link is fetched again ────────────────────────────────────────
 * The URL is presigned and lives minutes (§2.5). After a few reloads on the ID
 * step it had died, the face could not be loaded, and the comparison told the
 * person to start the whole sign-in over. On a miss this asks the backend for
 * the step again (`/auth/current`: enters nothing, charges nothing), which
 * mints a fresh link, keeps it in the cookie, and tries once more.
 */

// A per-request read of an httpOnly cookie — never prerendered, never cached.
export const dynamic = "force-dynamic";

const currentSchema = z.object({ face_capture_url: z.string().nullable().optional() }).loose();

export async function GET() {
  const challenge = await readChallenge();
  const first = await proxyImage(challenge.faceCaptureUrl, "face-capture");
  if (first.ok || !challenge.challengeToken) return first;

  try {
    const step = currentSchema.parse(
      await api.post<unknown>(AUTH_PATHS.current, { challenge_token: challenge.challengeToken }),
    );
    if (!step.face_capture_url || step.face_capture_url === challenge.faceCaptureUrl) return first;
    await writeChallenge({ ...challenge, faceCaptureUrl: step.face_capture_url });
    return proxyImage(step.face_capture_url, "face-capture");
  } catch (error) {
    console.warn("[face-capture] could not refresh the link:", error instanceof Error ? error.message : error);
    return first;
  }
}

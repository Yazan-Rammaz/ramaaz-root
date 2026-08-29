import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { openLink } from "@/lib/auth/link";

/**
 * The access link's landing point — where every sign-in begins.
 *
 * ── Why a Route Handler and not a page ──────────────────────────────────────
 * Opening the link has to WRITE the challenge cookie, and a Server Component
 * render may not mutate cookies. A page would have had to render, then bounce
 * through an action to store what it already knew.
 *
 * It also means nothing is ever rendered at a URL containing the token. The
 * handler answers with a redirect, so the address bar holds the token for one
 * request and the browser lands on a clean path — the token never reaches a
 * document, a referrer header, or an RSC payload.
 *
 * ── The path ────────────────────────────────────────────────────────────────
 * `/enter/<token>`. The backend must mint links as `{PUBLIC_URL}/enter/<token>`
 * to match.
 *
 * It sits at the app root rather than inside a route group, deliberately: it
 * renders nothing, so it wants no layout, and keeping it clear of (dashboard)
 * means the group's `requireSession()` gate can never be mistaken for applying
 * to a caller who by definition has no session yet.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Succeeds by redirecting (it throws NEXT_REDIRECT, which Next turns into a
  // 307), so reaching the next line at all means it was refused.
  //
  // The reason is deliberately NOT carried across. The backend answers every
  // refusal — unknown link, revoked, expired, out of range, suspended — with
  // one indistinguishable error, and this screen mirrors that: somebody holding
  // a forwarded link learns nothing about which condition tripped.
  await openLink(decodeURIComponent(token));
  redirect("/no-access");
}

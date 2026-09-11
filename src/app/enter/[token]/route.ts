import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { setLastLink, setSignInError } from "@/lib/auth/challenge";
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

// A GET with side effects must never be served from a cache, and must never be
// prerendered. Without this a 307 carrying somebody's Set-Cookie is a cacheable
// response sitting in front of the one endpoint that starts a sign-in.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Crawler user agents that fetch a URL purely to draw a preview card.
 *
 * WhatsApp is the one that matters here — it fetches every link it renders, on
 * the SENDER's send and again on the recipient's chat list — but every other
 * messenger does the same, and so do corporate URL-defence scanners.
 *
 * Note WhatsApp appears twice over: its crawler is `WhatsApp/2.x A`, while its
 * in-app browser sends an ordinary `Mozilla/...` agent. `isLinkPreviewFetch`
 * separates them on the `Mozilla/` prefix, so a human reading the message is
 * never mistaken for the crawler that preceded them.
 */
const CRAWLER_AGENTS = new RegExp(
  [
    // Named, because these are the ones actually seen on this endpoint.
    "whatsapp|facebookexternalhit|facebot|skypeuripreview|embedly",
    "slack-imgproxy|quora link preview|bingpreview|applebot|pinterest",
    // `bot` unanchored at the START so `bingbot`, `yandexbot`, `Discordbot`
    // and every other …bot are caught by one alternative rather than a list
    // that is out of date the day it is written. No browser agent string
    // contains "bot", "crawler" or "spider" — verified against the UA set in
    // the comment above.
    "bot\\b|crawler|spider|\\bpreview\\b",
    // Scripted clients. Belt and braces: the `Mozilla/` test below already
    // catches these, but naming them makes a log line self-explaining.
    "curl|wget|python-requests|go-http-client|okhttp|axios|node-fetch",
  ].join("|"),
  "i",
);

/**
 * Is this fetch a machine drawing a preview, rather than a person tapping?
 *
 * ⚠️ THE reason a link "already used" when the administrator had not touched it.
 * Opening a link is a state change — it POSTs /v1/auth/link, which starts the
 * 10-minute challenge and spends from its five attempts — and until this guard
 * existed any GET performed it. WhatsApp fetches the URL to build the preview
 * card the moment the message is composed, so the challenge was routinely
 * opened, and sometimes expired, before the recipient had seen the message.
 *
 * The signals, weakest last, all chosen so that a genuine top-level navigation
 * from a genuine browser fails every one of them:
 *
 *  1. `Sec-Purpose` / `Purpose: prefetch` — a speculative fetch, by definition
 *     not a person, and the response is discarded.
 *  2. `Sec-Fetch-Mode` present and not `navigate` — the browser is telling us
 *     this is a subresource or a script's fetch, not the address bar. Only
 *     applied when the header is present, so pre-16.4 Safari (which omits the
 *     Sec-Fetch family entirely) is judged by the rules below instead.
 *  3. A named crawler agent.
 *  4. No `Mozilla/` prefix at all. Every browser in existence sends one for
 *     compatibility reasons two decades old; scripted clients mostly do not.
 *     This is the catch-all for the scanners nobody has heard of.
 */
function isLinkPreviewFetch(req: NextRequest): boolean {
  const h = req.headers;

  if (h.get("sec-purpose")?.includes("prefetch")) return true;
  if (h.get("purpose") === "prefetch") return true;
  if (h.get("x-purpose") === "prefetch") return true;
  if (h.get("next-router-prefetch") === "1") return true;

  const mode = h.get("sec-fetch-mode");
  if (mode && mode !== "navigate") return true;

  const ua = h.get("user-agent") ?? "";
  if (!/^Mozilla\//i.test(ua)) return true;
  if (CRAWLER_AGENTS.test(ua)) return true;

  return false;
}

/**
 * What a preview crawler gets: a card, and no side effect whatsoever.
 *
 * Deliberately says nothing about the link — not whether it is valid, not that
 * a sign-in lives here. A forwarded message should render the same card for
 * everybody, because the card is generated from a fetch anyone can make.
 */
function previewCard(): NextResponse {
  const body = `<!doctype html><html><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta property="og:title" content="Ramaaz">
<meta property="og:description" content="Private access link.">
<title>Ramaaz</title></head><body></body></html>`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * `decodeURIComponent` throws `URIError` on a lone `%` — and a token pasted by
 * hand, or clipped by a chat client's URL detection, can easily carry one. That
 * threw out of the handler as an unhandled 500, which reads as the site being
 * down rather than the link being malformed.
 */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Before anything else, and before the backend is touched at all.
  if (isLinkPreviewFetch(req)) return previewCard();

  // Succeeds by redirecting (it throws NEXT_REDIRECT, which Next turns into a
  // 307), so reaching the next line at all means it was refused.
  //
  // The reason is carried in a short-lived httpOnly cookie rather than the
  // query string, so it is not re-shown by a back-navigation to a URL that no
  // longer describes reality. It is still one indistinguishable refusal —
  // `signInError()` maps every /auth/link failure to the same sentence — so
  // somebody holding a forwarded link learns nothing about which condition
  // tripped. What it buys is that the ADMINISTRATOR is told "this expired,
  // open your link again" instead of staring at a blank wall.
  const attempted = safeDecode(token);

  // ⚠️ BEFORE the call, not after.
  //
  // `openLink` succeeds by REDIRECTING, and a redirect signals by throwing —
  // so nothing after it runs on the happy path. Recorded afterwards, the link
  // was remembered only when it was REFUSED, which is the one case where
  // offering it again is least likely to help. The administrator who got in
  // normally and then timed out ten minutes later had nothing on /no-access at
  // all, because this line never executed for them.
  //
  // Recording it first costs nothing: the token is already in this URL, and the
  // cookie is httpOnly and dies with the challenge.
  await setLastLink(attempted);

  const { error } = await openLink(attempted);
  await setSignInError(error);
  redirect("/no-access");
}

/**
 * The headers that tell the backend WHO is really calling.
 *
 * ── The problem these solve ─────────────────────────────────────────────────
 * The browser never reaches the backend (AGENTS.md §2), so every `/v1/auth/*`
 * request leaves from this Worker and the address the backend sees is ours.
 * Three things keyed on the caller therefore measured the wrong party:
 *
 *   rate limits        one budget shared by every administrator at once — and
 *                      anyone who could load the sign-in page could spend the
 *                      10-per-minute on /auth/link for everybody.
 *   link conditions    a link's country and address restrictions resolved to
 *                      our data centre rather than the person.
 *   RESUME             ⚠️ the worst of the three. Re-opening a link resumes a
 *                      sign-in already in progress only for a caller that looks
 *                      like the one that made the progress — same link, same
 *                      address, same User-Agent. With a constant address and a
 *                      constant User-Agent going out, that check ALWAYS PASSED,
 *                      so anyone holding the link could pick up somebody else's
 *                      half-finished sign-in, past a private code they never
 *                      entered. Backend confirmed, round 2 §6.
 *
 * ── Why a shared secret and not an IP allowlist ─────────────────────────────
 * The backend trusts these only when `X-Edge-Secret` matches; without it they
 * are ignored and the caller is resolved as before, so setting them from
 * outside gains an attacker nothing. An allowlist was rejected because
 * Cloudflare's egress addresses are shared by every Worker on the platform —
 * allowlisting ours would trust anybody's.
 *
 * ── Local development needs no special case ─────────────────────────────────
 * The rule is "send nothing rather than something empty", and that falls out of
 * the gate below: no secret, no headers. `EDGE_SECRET` is a Cloudflare secret
 * and is deliberately NOT in `.dev.vars`, so `next dev` omits them and the
 * backend treats the developer's machine as the caller with its own budget.
 * (Links issued for development simply carry no address or country condition —
 * those are per-link and optional.)
 */

/** Where the real caller's details come from: the request the BROWSER made. */
export type EdgeContext = {
  /** `CF-Connecting-IP` on the incoming request. */
  ip?: string | null;
  /** `CF-IPCountry` on the incoming request. `XX` means Cloudflare didn't know. */
  country?: string | null;
  /** The browser's own `User-Agent`, which resume matching compares exactly. */
  userAgent?: string | null;
};

/**
 * Identifies this client when there is no browser request to speak for — a
 * build-time render, a scheduled call. Keeps requests attributable rather than
 * anonymous.
 */
export const FALLBACK_USER_AGENT = "RamaazRootDashboard/1.0";

/**
 * Build the outgoing headers for one backend call.
 *
 * Pure, and takes its inputs rather than reading them: the two callers live in
 * different runtimes — `lib/api/server.ts` reads `next/headers`, middleware
 * reads its own `NextRequest` — and neither can use the other's source.
 *
 * `User-Agent` is forwarded whenever we know it, secret or not. It costs
 * nothing and it already narrows the resume hole above: two administrators on
 * different browsers stop looking like each other even while the address is
 * still ours.
 */
export function edgeHeaders(
  ctx: EdgeContext,
  secret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": ctx.userAgent || FALLBACK_USER_AGENT,
  };

  // No secret → the backend would ignore these anyway, and an ignored header is
  // worse than an absent one: it reads as an attempt to spoof.
  //
  // No address → nothing worth claiming. Sending `X-Edge-Client-IP: ""` with a
  // valid secret would have the backend trust an empty address, which is how a
  // whole environment ends up resolving to "unknown".
  if (!secret || !ctx.ip) return headers;

  headers["X-Edge-Secret"] = secret;
  headers["X-Edge-Client-IP"] = ctx.ip;

  // Country is genuinely optional — Cloudflare answers `XX` when it cannot
  // tell, and `T1` for Tor, both of which the backend has its own handling for.
  // Absent is different from unknown, so only send what we were given.
  if (ctx.country) headers["X-Edge-Client-Country"] = ctx.country;

  return headers;
}

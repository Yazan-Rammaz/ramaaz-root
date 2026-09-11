import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readChallenge } from "@/lib/auth/challenge";
import { getAccessToken } from "@/lib/auth/cookies";
import { KYC_TENANT, kycWorkerUrl } from "@/lib/kyc/worker";
import { cfEnv } from "@/lib/cf-env";

/**
 * The KYC proxy — the browser's only route to the `ramaaz-kyc` Worker.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * The browser must never call the Worker directly (AGENTS.md §2), and could not
 * anyway: `connect-src 'self'` in the CSP forbids it. So camera frames go to
 * OUR origin, and this handler attaches the credential server-side and forwards.
 *
 * A Route Handler rather than a Server Action, deliberately: liveness posts
 * frames repeatedly and the RSC action protocol is the wrong transport for
 * that. This is the one sanctioned exception to "mutations go through actions".
 *
 * ── The credential ──────────────────────────────────────────────────────────
 * Two cases, and the difference matters more than it looks:
 *
 *   mid sign-in   no session exists yet, so the CHALLENGE token goes out as
 *                 `X-Step-Token`. That header is what tells the Worker to commit
 *                 the result to the step-scoped backend route.
 *   signed in     an ordinary `Authorization: Bearer` (the idle-lock re-verify).
 *
 * Both are read from httpOnly cookies here. Neither ever reaches client JS.
 */

/** Body-carrying methods. GET/HEAD must not send one. */
const WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Service binding to the KYC Worker.
 *
 * ⚠️ On Cloudflare this is NOT optional. Same-account Worker→Worker fetches
 * over a `*.workers.dev` URL never reach the target Worker — Cloudflare answers
 * its own bare 404 page instead. The failure only appears once deployed,
 * because plain fetch works fine in local dev, which makes it an expensive
 * thing to discover late.
 *
 * Returns null outside workerd (`next dev`), where fetching `kycWorkerUrl()`
 * directly is correct.
 */
function workerBinding(): { fetch: typeof fetch } | null {
  // An explicit KYC_WORKER_URL WINS over the binding, and that is the whole
  // point of setting one.
  //
  // `next dev` runs `initOpenNextCloudflareForDev()`, so the binding exists in
  // dev too — and it resolves through wrangler's dev registry to whatever local
  // `wrangler dev` session happens to be running. When that session dies, the
  // binding resolves to nothing and every KYC call fails, with no fallback to
  // the deployed Worker. The symptom is a face check that "stopped working"
  // with nothing wrong on either side of it.
  //
  // Setting the URL is how you opt out: point dev at the deployed Worker (or a
  // local `wrangler dev` on 8787) and get one predictable target. Cloudflare
  // sets no such var, so production keeps using the binding — which is
  // MANDATORY there, since a same-account Worker→Worker fetch over
  // *.workers.dev never arrives.
  // ⚠️ DEV ONLY, and the guard is load-bearing.
  //
  // `KYC_WORKER_URL` lives in `.env.local`, and Next INLINES `process.env`
  // reads at build time — so without the NODE_ENV check the deployed bundle
  // carries that value, skips the binding, and plain-fetches
  // `ramaaz-kyc.yazan-adnof.workers.dev`. A same-account Worker→Worker fetch
  // over `*.workers.dev` never arrives: Cloudflare answers its own 404 (a
  // 17-byte body), and every KYC call fails in production while working
  // perfectly in dev. That is precisely the trap the comment above describes,
  // and it shipped once already.
  if (process.env.NODE_ENV !== 'production' && process.env.KYC_WORKER_URL) return null;

  try {
    const { env } = getCloudflareContext();
    return (env as { KYC_WORKER?: { fetch: typeof fetch } }).KYC_WORKER ?? null;
  } catch {
    return null;
  }
}

async function proxy(req: NextRequest): Promise<Response> {
  const { pathname, search } = req.nextUrl;

  const headers: Record<string, string> = {
    // Routes this request to root's backend and root's signing secrets. Without
    // it the Worker would default to RDB — see ramaaz-kyc/INTEGRATION.md §2.3.
    "X-Ramaaz-Tenant": KYC_TENANT,
    Accept: "application/json",
  };

  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  // ── The liveness bench ─────────────────────────────────────────────────────
  //
  // `/api/kyc/liveness-lab/*` runs the AWS liveness check on its own, so it can
  // be attacked repeatedly without walking a whole sign-in between attempts.
  // Testing anti-spoofing takes dozens of tries, and a bench that costs a full
  // login per try does not get used.
  //
  // Two locks, and the secret never reaches the browser:
  //
  //   1. the caller must already be inside the design gallery — in production
  //      that means holding the `design_gallery` cookie, which is itself a key
  //      exchange (see app/design/layout.tsx);
  //   2. this handler adds `X-Liveness-Lab` from OUR secret. The Worker 404s
  //      those routes without it, and 404s them outright if its own
  //      `LIVENESS_LAB_SECRET` is unset — which is the production default.
  //
  // The bench cannot sign anyone in: it never reads a challenge, never returns
  // an image, never compares a face and never mints a stepToken. All it can
  // produce is a status and a number. See the block above the routes in
  // ramaaz-kyc/src/routes/kyc.ts.
  if (pathname.includes("/liveness-lab/")) {
    // `cfEnv`, not `process.env` — these live in `.dev.vars` and in Cloudflare
    // secrets, neither of which reaches `process.env` under `next dev`. Reading
    // them the obvious way returned undefined, and the gate below then failed
    // closed and looked exactly like a wrong secret.
    const secret = cfEnv("LIVENESS_LAB_SECRET");
    const unlocked =
      process.env.NODE_ENV === "development" ||
      req.cookies.get("design_gallery")?.value === cfEnv("DESIGN_GALLERY_KEY");

    if (!secret || !unlocked) {
      // 404, not 403 — the same answer /design gives, and for the same reason:
      // a 403 confirms there is something here.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    headers["X-Liveness-Lab"] = secret;
  }

  // Prefer the challenge: during sign-in it is the ONLY credential that exists,
  // and it must go as X-Step-Token rather than a bearer so the Worker commits
  // to the step-scoped route. A stale access cookie must not shadow it.
  const challenge = await readChallenge();
  if (challenge.challengeToken) {
    headers["X-Step-Token"] = challenge.challengeToken;
  } else {
    const accessToken = await getAccessToken();
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  }

  // Cookies are deliberately NOT forwarded. The Worker can read them, but
  // forwarding the whole Cookie header hands it every cookie this user holds
  // when it needs exactly one value — and ours are named for root, not for the
  // tenant defaults it would look for.

  const body = WITH_BODY.has(req.method) ? await req.arrayBuffer() : undefined;
  const target = `${kycWorkerUrl()}${pathname}${search}`;

  let res: Response;
  try {
    const binding = workerBinding();
    const init = { method: req.method, headers, body };

    // WHICH TRANSPORT, logged before the call.
    //
    // The two are not interchangeable in production: a service binding
    // reaches the Worker, while a plain fetch to `*.workers.dev` from a Worker
    // on the SAME ACCOUNT never arrives — Cloudflare answers its own 404. The
    // symptom is a KYC call that fails with a tiny 404 body and no trace in
    // either Worker's tail, which is indistinguishable from the Worker
    // rejecting the request. Knowing which path was taken is the difference
    // between debugging our proxy and debugging the KYC service.
    console.log(
      `[kyc proxy] ${req.method} ${pathname} via ${binding ? 'binding' : 'fetch'} → ${target}`,
    );

    res = binding ? await binding.fetch(target, init) : await fetch(target, init);
  } catch (error) {
    // "fetch failed" on its own is useless — surface the cause chain, which is
    // where a DNS or binding problem actually shows up.
    console.error(
      `[kyc proxy] ${req.method} ${pathname} → ${kycWorkerUrl()} failed:`,
      error,
      "| cause:",
      (error as { cause?: unknown })?.cause,
    );
    return NextResponse.json(
      { error: "The verification service is unavailable." },
      { status: 502 },
    );
  }

  // Passed through verbatim, status included. `services/kycApi.ts` reads real
  // error bodies out of non-2xx responses — a 'failed' verdict arrives that way
  // — so rewriting them here would break the caller's own error handling.
  const payload = await res.text();

  // ── The only place a deployed run's verdict is visible ──────────────────────
  //
  // On Cloudflare this proxy reaches the Worker through a SERVICE BINDING, and
  // a binding's sub-request does not appear in the target Worker's `wrangler
  // tail`, nor does the target's console output appear in ours. So a deployed
  // face check that fails leaves no trace anywhere: the screen shows one fixed
  // line by design, and both tails show only that a request happened.
  //
  // Logged here, on our side of the binding, and deliberately field-by-field:
  //   NEVER the whole body — it carries `stepToken`, a single-use credential
  //   that must not be written to a log, and on other routes base64 images.
  // Only the verdict fields, which are what an operator actually needs.
  try {
    const body = JSON.parse(payload) as Record<string, unknown>;
    console.log(
      `[kyc proxy] ${req.method} ${pathname} → ${res.status}`,
      JSON.stringify({
        status: body.status,
        reason: body.reason,
        code: body.code,
        message: body.message,
        faceMatchScore: body.faceMatchScore,
        livenessConfidence: body.livenessConfidence,
        selfieVsIdScore: body.selfieVsIdScore,
        error: body.error,
        hasStepToken: Boolean(body.stepToken),
      }),
    );
  } catch {
    // Not JSON — an image or an empty body. The status alone is the signal.
    console.log(`[kyc proxy] ${req.method} ${pathname} → ${res.status} (${payload.length}b)`);
  }
  // ⚠️ 204/205/304 are "null body statuses" — the Response constructor REFUSES
  // a body with them, and an empty string still counts as a body. So
  // `new Response(await res.text(), { status: 204 })` throws TypeError and this
  // proxy answers 500 for a response the Worker handled perfectly.
  //
  // It went unnoticed because nothing upstream returned a 204 until the camera
  // hand-off, where 204 is the normal "the other side has not answered yet" and
  // is polled once a second. The symptom was a 500 on every poll.
  const NULL_BODY = new Set([204, 205, 304]);

  return new Response(NULL_BODY.has(res.status) ? null : payload, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
      // Biometric traffic: never let a shared cache hold any of it.
      "Cache-Control": "no-store",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

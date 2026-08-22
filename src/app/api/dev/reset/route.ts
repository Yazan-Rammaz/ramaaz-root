import { NextResponse } from "next/server";
import { DEV_TOKEN_COOKIE } from "@/lib/auth/registration-token";

/**
 * TEMPORARY dev convenience: mint a fresh root admin and hand its credentials
 * to the login screen so the private code and password fill themselves in.
 *
 * A Route Handler rather than a Server Action, by request — the browser calls
 * this directly (see features/auth/dev/useDevCredentials.ts).
 *
 * ── ⚠️ This is enabled on the DEPLOYED worker too ───────────────────────────
 * It wraps POST /v1/dev/reset-root, which DELETES the current root admin and
 * creates a replacement, and it returns that admin's plaintext password to
 * whoever called it.
 *
 * It originally also required NODE_ENV !== production. That guard was removed
 * by request, so the ONLY thing standing in front of it is the flag below.
 * On the public worker URL that means anyone who finds the endpoint can reset
 * the root admin and read the new password. It cannot be protected further:
 * the caller is the browser, so any shared secret would ship in the client
 * bundle and be equally public.
 *
 * That is a deliberate, temporary trade for a staging-only environment. Before
 * this worker is ever pointed at production data, set NEXT_PUBLIC_DEV_AUTOFILL
 * to "0" and redeploy, or delete this route.
 *
 * ── Turning it off ─────────────────────────────────────────────────────────
 * Locally:  NEXT_PUBLIC_DEV_AUTOFILL=0 in .env.local, restart `npm run dev`.
 * Deployed: set it to "0" in wrangler.jsonc and `npm run deploy`.
 * One flag disables the route AND the client that calls it. Deleting this file
 * and src/features/auth/dev/ removes it outright.
 */

// Reads process.env and holds the token in module memory.
export const runtime = "nodejs";

function isEnabled() {
  // Flag only — the NODE_ENV check was removed so this works on the deployed
  // worker. See the warning above.
  return process.env.NEXT_PUBLIC_DEV_AUTOFILL === "1";
}

export async function POST() {
  if (!isEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const base = process.env.NEST_API_URL;
  const key = process.env.DEV_RESET_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { error: "NEST_API_URL and DEV_RESET_KEY must both be set in .env.local" },
      { status: 500 },
    );
  }

  let body: {
    private_code?: string;
    password?: string;
    phone?: string;
    invitation_token?: string;
    error?: { message?: string };
  } | null = null;

  try {
    const res = await fetch(`${base}/v1/dev/reset-root`, {
      method: "POST",
      headers: {
        "X-Dev-Reset-Key": key,
        Accept: "application/json",
        "User-Agent": "RamaazRootDashboard/1.0",
      },
      cache: "no-store",
    });
    body = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json(
        { error: body?.error?.message ?? `reset-root failed (${res.status})` },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Could not reach the reset endpoint" },
      { status: 502 },
    );
  }

  if (!body?.private_code || !body?.password || !body?.invitation_token) {
    return NextResponse.json(
      { error: "reset-root returned an unexpected shape" },
      { status: 502 },
    );
  }

  // The token is NOT in the JSON — the browser has no use for it. It rides back
  // as an httpOnly cookie so the sign-in Server Action can read it.
  //
  // A cookie specifically, NOT module state: Route Handlers and Server Actions
  // are separate entry points and do not reliably share module instances, so a
  // variable set here was invisible to the action, which then fell back to the
  // spent token in .env.local and failed with "That invitation link is not
  // valid".
  const res = NextResponse.json({
    privateCode: body.private_code,
    password: body.password,
    phone: body.phone ?? null,
  });

  res.cookies.set(DEV_TOKEN_COOKIE, body.invitation_token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Comfortably longer than one registration run; each reset overwrites it.
    maxAge: 60 * 60,
  });

  return res;
}

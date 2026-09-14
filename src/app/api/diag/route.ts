import { NextResponse, type NextRequest } from "next/server";
import { readChallenge } from "@/lib/auth/challenge";
import { cfEnv } from "@/lib/cf-env";
import {
    DIAG_MAX_BODY_BYTES,
    diagPayloadSchema,
    redactPath,
} from "@/lib/diag/events";

/**
 * The diagnostic sink — forwards the browser's account of a failure to
 * `ramaaz-observe`, which owns the store and the dashboard.
 *
 * ── Why this app forwards instead of posting straight there ─────────────────
 * The SDK can post cross-origin, and on Vercel or Pages that is exactly how it
 * should be used. Not here, for two reasons:
 *
 *  1. `connect-src 'self'` (middleware.ts) forbids this browser from talking to
 *     any origin but ours, and that restriction is load-bearing — it is what
 *     stops a tampered page from shipping a camera frame somewhere. Relaxing it
 *     to admit a logging host would spend a real security property on
 *     convenience.
 *
 *  2. The correlation id is the whole point, and only the server has it. The
 *     challenge id lives in an httpOnly cookie precisely so client JS cannot
 *     read it — so the browser could never label its own session with the id
 *     the backend logs quote. Here it is one `readChallenge()` away.
 *
 * ── Always 204 ──────────────────────────────────────────────────────────────
 * Every path, including the rejected ones. Reached from a sign-in that has not
 * authenticated yet, so a distinguishing reply would tell a prober whether a
 * challenge id is real — and the browser can do nothing with the answer anyway.
 * A failed report must never become an error the collector then tries to report.
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
    // Length before reading. A body is a body whether or not it parses, and
    // this endpoint is unauthenticated by design.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > DIAG_MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

    let raw: unknown;
    try {
        const text = await request.text();
        if (text.length > DIAG_MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });
        raw = JSON.parse(text);
    } catch {
        return new NextResponse(null, { status: 204 });
    }

    const parsed = diagPayloadSchema.safeParse(raw);
    if (!parsed.success) return new NextResponse(null, { status: 204 });
    const payload = parsed.data;

    // Redact AGAIN, server-side. The browser already did, but the browser is not
    // a trusted place to enforce a rule about credentials — anything can POST
    // here with any path it likes.
    const events = payload.events.map((event) =>
        event.path ? { ...event, path: redactPath(event.path) } : event,
    );

    const { challengeId } = await readChallenge();

    const url = cfEnv("OBSERVE_URL");
    const key = cfEnv("OBSERVE_KEY");
    if (!url || !key) {
        // Unconfigured is not an error: a sign-in must work whether or not the
        // logging does. Say so once, where it can be seen.
        console.warn("[diag] OBSERVE_URL/OBSERVE_KEY unset — dropping", events.length, "events");
        return new NextResponse(null, { status: 204 });
    }

    try {
        await fetch(`${url.replace(/\/$/, "")}/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                key,
                sid: payload.sid,
                seq: payload.seq,
                // The join between this browser session and every backend log
                // line for the same sign-in.
                correlation: challengeId,
                ua: payload.ua,
                screen: payload.screen,
                events,
            }),
        });
    } catch (err) {
        // Never fail a sign-in over logging. This lands in Workers Logs, which
        // is the sink that still works when the other one does not.
        console.error("[diag] forward to observe failed:", err);
    }

    return new NextResponse(null, { status: 204 });
}

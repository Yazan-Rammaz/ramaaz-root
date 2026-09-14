import { NextResponse, type NextRequest } from "next/server";
import { readChallenge } from "@/lib/auth/challenge";
import {
    DIAG_MAX_BODY_BYTES,
    DIAG_TTL_SECONDS,
    diagPayloadSchema,
    redactPath,
} from "@/lib/diag/events";
import { diagKey, diagStore } from "@/lib/diag/store";

/**
 * The diagnostic sink — where the browser's account of a failure is kept.
 *
 * Writes each flush to KV under the sign-in's challenge id, and mirrors a
 * one-line summary to `console.log` so it also lands in Workers Logs. Two
 * sinks, two jobs: KV answers "what happened to this person last Tuesday" for
 * thirty days, the log line answers "what is happening right now" in the
 * dashboard, where a tail is already watching.
 *
 * ── Always 204 ──────────────────────────────────────────────────────────────
 * Every path returns 204, including the rejected ones. This endpoint is reached
 * from a sign-in that has not authenticated yet, so its replies are readable by
 * anyone holding a link; distinguishing "stored" from "rejected" would tell a
 * prober whether their challenge id is real. The browser has no use for the
 * answer either — it cannot fix anything with it, and a failed report must not
 * become an error the collector then tries to report.
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
    // ⚠️ Length first, before reading. A body is a body whether or not it
    // parses, and letting an unbounded one through to `.json()` is how an
    // unauthenticated endpoint becomes a way to spend someone's memory.
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

    // Redact AGAIN, server-side. The browser already did, but the browser is
    // not a trusted place to enforce a rule about credentials — anything can
    // POST here with any path it likes.
    const events = payload.events.map((event) =>
        event.path ? { ...event, path: redactPath(event.path) } : event,
    );

    // The correlation this whole feature exists for: the challenge id is read
    // from the httpOnly cookie SERVER-SIDE, never sent by the client, so a
    // bundle cannot be filed against somebody else's sign-in.
    const { challengeId } = await readChallenge();

    const worst = events.some((e) => e.level === "error" || e.status === 0)
        ? "error"
        : events.some((e) => e.level === "warn" || (e.status ?? 200) >= 400)
          ? "warn"
          : "info";

    // The Workers Logs half. One line, greppable, no payload — the bundle in KV
    // is the detail, this is the pointer to it.
    console.log(
        JSON.stringify({
            msg: "diag",
            level: worst,
            challengeId: challengeId ?? "anon",
            sid: payload.sid,
            seq: payload.seq,
            events: events.length,
            first: events[0]?.msg?.slice(0, 200),
        }),
    );

    const store = diagStore();
    if (!store) return new NextResponse(null, { status: 204 });

    try {
        await store.put(
            diagKey(challengeId, payload.sid, payload.seq),
            JSON.stringify({
                storedAt: new Date().toISOString(),
                challengeId: challengeId ?? null,
                sid: payload.sid,
                seq: payload.seq,
                ua: payload.ua,
                screen: payload.screen,
                events,
            }),
            { expirationTtl: DIAG_TTL_SECONDS },
        );
    } catch (err) {
        // A KV write failing must not fail a sign-in. This lands in Workers
        // Logs, which is the sink that still works when the other one does not.
        console.error("[diag] KV write failed:", err);
    }

    return new NextResponse(null, { status: 204 });
}

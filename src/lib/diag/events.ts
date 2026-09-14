import { z } from "zod";

/**
 * The diagnostic record — what the browser is allowed to tell us about a
 * sign-in that went wrong.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Workers Logs capture this Worker, and the KYC Worker captures itself. Neither
 * can see the browser, and the browser is where the interesting failures are:
 * a camera that will not open, an AWS liveness detector that refuses, a fetch
 * that never returned. Those reach `console.error` on a tablet and are gone the
 * moment somebody closes the tab.
 *
 * That is not a hypothetical. A face check failed on a tablet with "Could not
 * start the face check", and answering "why" took reading four repositories and
 * a pasted backend log, because the one line naming the cause
 * (`[liveness] detector error`) had run in a browser nobody had a console
 * attached to. This is the fix for that: the line is shipped here instead.
 *
 * ── What may NOT be in here ─────────────────────────────────────────────────
 * Metadata only, and the shape below is the enforcement. There is no field for
 * a request body, a response body, or a header, so there is nowhere for a face
 * image, a challenge token, a private code, a Bearer token or a signed S3 URL
 * to land — not by oversight, and not by a future change that forgets to add a
 * key to a denylist. Adding such a field is a deliberate act and should be
 * argued for in review.
 *
 * `path` is the one field that could still carry a secret, because
 * `/enter/<token>` puts the access-link token in a URL path. `redactPath`
 * handles it, and it is applied on BOTH sides — in the browser before sending
 * and again here before storing.
 */

/** Per flush. A burst bigger than this is a loop, and a loop needs no more. */
export const DIAG_MAX_EVENTS = 200;

/** Hard ceiling on a single POST, enforced before the body is even parsed. */
export const DIAG_MAX_BODY_BYTES = 64 * 1024;

/**
 * How long a bundle survives. Long enough that "this happened to someone last
 * week, what was it" is answerable, short enough that this never becomes a
 * quiet archive of who signed in and when.
 */
export const DIAG_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Flushes per session. The browser stops after this many, so one wedged page
 * cannot spend an account's whole KV write allowance on its own.
 */
export const DIAG_MAX_FLUSHES = 20;

export const diagEventSchema = z.object({
    /** Epoch ms, from the browser's clock. Skewed clocks are normal; the order within a bundle is what matters. */
    t: z.number().int(),
    kind: z.enum(["console", "error", "rejection", "fetch", "note"]),
    level: z.enum(["log", "info", "warn", "error"]).optional(),
    /** Console text or error message, already truncated by the collector. */
    msg: z.string().max(2000).optional(),
    /** Error constructor name — `DOMException`, `TypeError`, and for AWS the liveness state. */
    name: z.string().max(200).optional(),
    stack: z.string().max(4000).optional(),
    method: z.string().max(10).optional(),
    /** Same-origin pathname, redacted. Never a query string. */
    path: z.string().max(500).optional(),
    status: z.number().int().optional(),
    /** Round trip in ms. */
    ms: z.number().int().optional(),
});

export type DiagEvent = z.infer<typeof diagEventSchema>;

export const diagPayloadSchema = z.object({
    /** Browser-generated, per tab. Correlates flushes; carries no meaning server-side. */
    sid: z
        .string()
        .min(8)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/, "sid must be url-safe"),
    seq: z.number().int().min(0).max(DIAG_MAX_FLUSHES),
    ua: z.string().max(400).optional(),
    /** e.g. "1024x768x2" — the framerate/camera failures are device-shaped. */
    screen: z.string().max(40).optional(),
    events: z.array(diagEventSchema).max(DIAG_MAX_EVENTS),
});

export type DiagPayload = z.infer<typeof diagPayloadSchema>;

/**
 * Strip anything from a URL that could be a credential.
 *
 * ⚠️ The query string goes ENTIRELY. Not filtered — removed. An allowlist of
 * safe query keys would be a denylist wearing a hat: the next person to add
 * `?token=` to a URL would not know to update it.
 *
 * Path segments are the harder case, and the reason this is not a one-liner:
 * `/enter/<token>` carries the access-link token in the path itself, and that
 * token is the single most valuable thing in this app — it mints challenges for
 * the life of the link. Any segment that looks like an opaque id is replaced
 * with a placeholder naming what it was.
 */
export function redactPath(input: string): string {
    let pathname = input;
    try {
        // Absolute or relative — both resolve against a throwaway base.
        pathname = new URL(input, "https://x.invalid").pathname;
    } catch {
        pathname = input.split("?")[0] ?? input;
    }

    const segments = pathname.split("/");
    return segments
        .map((segment, i) => {
            if (!segment) return segment;
            // The known-sensitive route, named rather than guessed at.
            if (i > 0 && segments[i - 1] === "enter") return "[token]";
            // Anything long and opaque: ULIDs, UUIDs, JWTs, base64url blobs.
            if (segment.length >= 16 && /^[A-Za-z0-9._~-]+$/.test(segment)) {
                return "[id]";
            }
            return segment;
        })
        .join("/");
}

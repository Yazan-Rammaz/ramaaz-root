import {
    DIAG_MAX_EVENTS,
    DIAG_MAX_FLUSHES,
    redactPath,
    type DiagEvent,
} from "@/lib/diag/events";

/**
 * The browser half of the diagnostic record.
 *
 * Hooks `console.error`/`warn`, `window.onerror`, unhandled rejections and
 * `fetch`, buffers what they say, and posts it to `/api/diag` — which is the
 * only reason any of it survives the tab being closed.
 *
 * ── Three rules this has to obey ────────────────────────────────────────────
 *  1. NEVER change what the page does. Every hook calls through to the original
 *     and returns what it returned. A collector that swallows an error, or
 *     turns a failed fetch into a resolved one, is worse than no collector.
 *  2. NEVER recurse. Our own POST to /api/diag is not recorded, and a failure
 *     to report is never itself reported — that is an infinite loop with a
 *     network bill attached.
 *  3. NEVER send a credential. Arguments are stringified to metadata only and
 *     paths go through `redactPath` here as well as on the server.
 */

const ENDPOINT = "/api/diag";

let started = false;
let buffer: DiagEvent[] = [];
let seq = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Set while our own POST is in flight, so the fetch hook ignores it. */
let reporting = false;

/** Per tab. `crypto.randomUUID` is present in every browser that can run this app. */
function sessionId(): string {
    const KEY = "root_diag_sid";
    try {
        const existing = sessionStorage.getItem(KEY);
        if (existing) return existing;
        const made = crypto.randomUUID().replace(/-/g, "");
        sessionStorage.setItem(KEY, made);
        return made;
    } catch {
        // Private mode, or storage disabled. A per-load id still correlates one
        // page's events with each other, which is most of the value.
        return crypto.randomUUID().replace(/-/g, "");
    }
}

let sid = "";

/**
 * Console arguments → one string, with no chance of a live object being walked
 * into something enormous.
 *
 * An Error is unpacked deliberately: `String(err)` on a DOMException gives
 * "DOMException: ..." and drops `name`, which for the AWS liveness detector is
 * the entire diagnosis (`CAMERA_FRAMERATE_ERROR` vs `CAMERA_ACCESS_ERROR`).
 */
function describe(args: unknown[]): { msg: string; name?: string; stack?: string } {
    let name: string | undefined;
    let stack: string | undefined;

    const parts = args.map((arg) => {
        if (arg instanceof Error) {
            name ??= arg.name;
            stack ??= arg.stack?.slice(0, 4000);
            return `${arg.name}: ${arg.message}`;
        }
        if (typeof arg === "string") return arg;
        if (typeof arg === "object" && arg !== null) {
            // AWS's detector reports `{ state: 'CAMERA_FRAMERATE_ERROR', ... }`,
            // and that state IS the answer — lift it rather than lose it in a
            // truncated JSON blob.
            const state = (arg as { state?: unknown }).state;
            if (typeof state === "string") name ??= state;
            try {
                return JSON.stringify(arg).slice(0, 600);
            } catch {
                return "[unserialisable]";
            }
        }
        return String(arg);
    });

    return { msg: parts.join(" ").slice(0, 2000), name, stack };
}

function record(event: DiagEvent): void {
    // Drop rather than grow without bound. The first events of a failure are
    // the ones that explain it; the thousandth repeat of the same loop is not.
    if (buffer.length >= DIAG_MAX_EVENTS) return;
    buffer.push(event);
    scheduleFlush();
}

function scheduleFlush(): void {
    if (flushTimer !== null) return;
    // Batched, not per-event: each flush is a KV write, and a chatty page
    // should not cost hundreds of them.
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush(false);
    }, 10_000);
}

async function flush(final: boolean): Promise<void> {
    if (buffer.length === 0 || seq >= DIAG_MAX_FLUSHES) return;

    const events = buffer;
    buffer = [];
    const body = JSON.stringify({
        sid,
        seq: seq++,
        ua: navigator.userAgent.slice(0, 400),
        screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}x${window.devicePixelRatio ?? 1}`,
        events,
    });

    // ⚠️ On unload, `sendBeacon` is the ONLY thing that survives. A fetch
    // started during pagehide is cancelled with the document, which loses
    // precisely the last events before a crash or a navigation away — the ones
    // worth having.
    if (final && typeof navigator.sendBeacon === "function") {
        try {
            navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
        } catch {
            // Nothing to be done at this point in the page's life.
        }
        return;
    }

    reporting = true;
    try {
        await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
        });
    } catch {
        // Reporting failed. Deliberately silent: logging it would hit our own
        // console hook, record an event, schedule a flush, and fail again.
    } finally {
        reporting = false;
    }
}

/**
 * Begin collecting. Safe to call more than once — React 19 in development
 * mounts effects twice, and double-hooking `console.error` would record every
 * message twice and make the record lie about how often things happened.
 */
export function startDiagnostics(): void {
    if (started || typeof window === "undefined") return;
    started = true;
    sid = sessionId();

    for (const level of ["warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            original(...args);
            const { msg, name, stack } = describe(args);
            record({ t: Date.now(), kind: "console", level, msg, name, stack });
        };
    }

    window.addEventListener("error", (event) => {
        record({
            t: Date.now(),
            kind: "error",
            level: "error",
            msg: String(event.message).slice(0, 2000),
            name: event.error instanceof Error ? event.error.name : undefined,
            stack: event.error instanceof Error ? event.error.stack?.slice(0, 4000) : undefined,
            path: event.filename ? redactPath(event.filename) : undefined,
        });
    });

    window.addEventListener("unhandledrejection", (event) => {
        const { msg, name, stack } = describe([event.reason]);
        record({ t: Date.now(), kind: "rejection", level: "error", msg, name, stack });
    });

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
        // Rule 2: our own report is not an event.
        if (reporting || url.includes(ENDPOINT)) return originalFetch(input, init);

        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const startedAt = Date.now();
        try {
            const response = await originalFetch(input, init);
            record({
                t: startedAt,
                kind: "fetch",
                method,
                path: redactPath(url),
                status: response.status,
                ms: Date.now() - startedAt,
            });
            // A failed call is worth reporting promptly, not in ten seconds'
            // time — the user may well close the tab in between.
            if (!response.ok) void flush(false);
            return response;
        } catch (err) {
            const { msg, name } = describe([err]);
            record({
                t: startedAt,
                kind: "fetch",
                method,
                path: redactPath(url),
                status: 0,
                ms: Date.now() - startedAt,
                msg,
                name,
            });
            void flush(false);
            // Rule 1: the caller still gets its rejection.
            throw err;
        }
    };

    // `pagehide` rather than `unload`: bfcache and mobile Safari never fire
    // `unload`, which is most of the tablets this console runs on.
    window.addEventListener("pagehide", () => void flush(true));
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flush(true);
    });
}

/** Attach a one-off note to the record — for a branch worth naming explicitly. */
export function noteDiagnostic(msg: string): void {
    if (!started) return;
    record({ t: Date.now(), kind: "note", msg: msg.slice(0, 2000) });
}

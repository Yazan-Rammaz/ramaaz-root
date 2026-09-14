'use client';

/**
 * Browser diagnostics — the whole integration, in one file.
 *
 * Copied from the ramaaz-observe repo (sdk/src/index.ts) with the app's own
 * config and its React mount appended. A copy rather than a dependency because
 * the package is not published to npm and the service lives in a private repo:
 * a file: dependency on a sibling checkout builds here and fails on Cloudflare,
 * which only has this repo. When it is published, delete everything above
 * `OBSERVE_URL` and import from the package instead.
 *
 * Two lines elsewhere are unavoidable and deliberate:
 *   · app/layout.tsx mounts <Observe /> — something has to start it, and it
 *     must be above every screen so hooks are installed before one can throw.
 *   · middleware.ts names this origin in connect-src — this app forbids the
 *     browser from talking to anything but itself, which is what stops a
 *     tampered page posting a camera frame elsewhere. One named host is the
 *     narrow way to allow this; switching the directive off is not.
 */

import { useEffect } from 'react';

/**
 * @ramaaz/observe — the browser collector.
 *
 * Zero dependencies and no framework assumptions on purpose: it runs in Next,
 * React, Vue, Svelte, Angular or a plain `<script>` tag, and it does not care
 * whether the app is hosted on Vercel, Cloudflare Pages, a Worker or a bucket.
 * It posts straight to the collector over CORS, so the host app needs no server
 * route of its own.
 *
 *   import { observe } from '@ramaaz/observe';
 *   observe({ url: 'https://observe.example.workers.dev', key: 'pk_root_…' });
 *
 * Three rules it obeys, in order of importance:
 *   1. NEVER change what the page does. Every hook calls through to the
 *      original and returns what it returned. A collector that swallows an
 *      error is worse than no collector.
 *   2. NEVER recurse. Its own POST is not recorded, and a failure to report is
 *      never itself reported — that is an infinite loop with a bill attached.
 *   3. NEVER send a credential. Paths are redacted, bodies are opt-in and
 *      scrubbed, and there is no field for a header.
 */

export type ObserveEvent = {
    t: number;
    kind: "console" | "error" | "rejection" | "fetch" | "note" | "screen";
    level?: "log" | "info" | "warn" | "error";
    msg?: string;
    name?: string;
    stack?: string;
    method?: string;
    path?: string;
    status?: number;
    ms?: number;
    body?: string;
};

export type ObserveOptions = {
    /** Collector origin, e.g. https://observe.ramaaz.workers.dev */
    url: string;
    /** Public project key. Write-only — it cannot read anything back. */
    key: string;
    /**
     * Ties this tab to something your backend also logs: a challenge id, an
     * order id, a user id. Without it you can still read a session; with it you
     * can find the session from a backend log line, which is the difference
     * between "we have logs" and "we can answer the question".
     */
    correlation?: string;
    /** Console levels to capture. Default: warn + error. `log`/`info` get noisy. */
    levels?: Array<"log" | "info" | "warn" | "error">;
    /**
     * Capture a redacted excerpt of response bodies.
     *
     * ⚠️ Off by default, and that default is deliberate. Even scrubbed, a body
     * is the most likely place for something personal to end up. Turn it on per
     * project, and use `denyBodyPaths` for the routes that carry images or
     * credentials.
     */
    captureBodies?: boolean;
    /** Never capture a body when the path matches. Checked after redaction. */
    denyBodyPaths?: RegExp[];
    /** Max characters kept per body excerpt. Default 2000. */
    maxBody?: number;
    /** Flush interval in ms. Default 10000. */
    flushMs?: number;
    /** Stop after this many flushes per session. Default 50. */
    maxFlushes?: number;
    /** Extra paths to skip entirely (health checks, polling, analytics). */
    ignorePaths?: RegExp[];
};

const DEFAULTS = {
    levels: ["warn", "error"] as const,
    maxBody: 2000,
    flushMs: 10_000,
    maxFlushes: 50,
};

/**
 * Anything that looks like a credential, wherever it appears.
 *
 * Deliberately shape-based rather than a list of key names. A denylist of keys
 * fails open — the next field somebody adds is captured until a human notices —
 * whereas "this looks like a JWT" keeps working for fields that do not exist
 * yet. Long opaque strings, JWTs, data URLs and signed URLs all go.
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
    [/data:[a-z/+-]+;base64,[A-Za-z0-9+/=]+/gi, "[data-uri]"],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]"],
    [/https?:\/\/[^\s"']*[?&](x-amz-|signature|token|sig)=[^\s"'&]+/gi, "[signed-url]"],
    [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
    [/\b[A-Za-z0-9_-]{40,}\b/g, "[opaque]"],
];

export function scrub(input: string): string {
    let out = input;
    for (const [pattern, replacement] of SECRET_SHAPES) out = out.replace(pattern, replacement);
    return out;
}

/**
 * Strip credentials out of a URL.
 *
 * The query string goes ENTIRELY — not filtered. An allowlist of safe query
 * keys is a denylist wearing a hat: the next person to add `?token=` would not
 * know to update it. Long opaque path segments become `[id]`, because plenty of
 * apps put a token in the path (`/enter/<token>` is one in our own).
 */
export function redactPath(input: string): string {
    let pathname = input;
    let origin = "";
    try {
        const parsed = new URL(input, "https://x.invalid");
        pathname = parsed.pathname;
        if (!input.startsWith("/")) origin = parsed.host === "x.invalid" ? "" : parsed.origin;
    } catch {
        pathname = input.split("?")[0] ?? input;
    }
    const cleaned = pathname
        .split("/")
        .map((segment) =>
            segment.length >= 16 && /^[A-Za-z0-9._~-]+$/.test(segment) ? "[id]" : segment,
        )
        .join("/");
    return origin + cleaned;
}

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
            // Libraries report their failure category on a `state` or `code`
            // field, and that field is usually the entire diagnosis — lift it
            // rather than lose it inside a truncated JSON blob.
            const tag = (arg as { state?: unknown; code?: unknown }).state ??
                (arg as { code?: unknown }).code;
            if (typeof tag === "string") name ??= tag;
            try {
                return JSON.stringify(arg).slice(0, 600);
            } catch {
                return "[unserialisable]";
            }
        }
        return String(arg);
    });
    return { msg: scrub(parts.join(" ")).slice(0, 2000), name, stack };
}

let started = false;

export function observe(options: ObserveOptions): void {
    if (started || typeof window === "undefined") return;
    started = true;

    const endpoint = options.url.replace(/\/$/, "") + "/ingest";
    const levels = options.levels ?? DEFAULTS.levels;
    const maxBody = options.maxBody ?? DEFAULTS.maxBody;
    const flushMs = options.flushMs ?? DEFAULTS.flushMs;
    const maxFlushes = options.maxFlushes ?? DEFAULTS.maxFlushes;

    let buffer: ObserveEvent[] = [];
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reporting = false;
    let correlation = options.correlation;

    const sid = (() => {
        const KEY = "__observe_sid";
        const make = () =>
            (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, "");
        try {
            const found = sessionStorage.getItem(KEY);
            if (found) return found;
            const made = make();
            sessionStorage.setItem(KEY, made);
            return made;
        } catch {
            // Private mode. A per-load id still groups one page's events, which
            // is most of the value.
            return make();
        }
    })();

    function record(event: ObserveEvent) {
        if (buffer.length >= 200) return;
        buffer.push(event);
        if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                void flush(false);
            }, flushMs);
        }
    }

    async function flush(final: boolean) {
        if (buffer.length === 0 || seq >= maxFlushes) return;
        const events = buffer;
        buffer = [];
        const payload = JSON.stringify({
            key: options.key,
            sid,
            seq: seq++,
            correlation,
            ua: navigator.userAgent.slice(0, 400),
            screen: `${screen?.width ?? 0}x${screen?.height ?? 0}x${devicePixelRatio ?? 1}`,
            url: redactPath(location.href),
            events,
        });

        // On unload, sendBeacon is the ONLY thing that survives — a fetch
        // started during pagehide dies with the document, losing exactly the
        // events before a crash or a navigation away.
        if (final && typeof navigator.sendBeacon === "function") {
            try {
                navigator.sendBeacon(endpoint, new Blob([payload], { type: "text/plain" }));
            } catch {
                /* nothing useful can be done this late in the page's life */
            }
            return;
        }

        reporting = true;
        try {
            /**
             * The one sanctioned `fetch` in the UI layer, and the lint rule is
             * right to ask about it.
             *
             * The ban exists so application data goes through the BFF — a
             * Server Action or a feature api module — and never straight from
             * the browser. This is not application data and there is no BFF to
             * go through: it is the collector's own transport to a separate
             * logging service, the same one RDB and Trydos post to, and routing
             * it through this app's server would defeat the point of a service
             * any front end can report to. The origin is named in `connect-src`
             * (middleware.ts); what crosses is metadata only.
             */
            // eslint-disable-next-line no-restricted-syntax
            await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: payload,
                keepalive: true,
                mode: "cors",
            });
        } catch {
            // Rule 2. Logging this would hit our own console hook and loop.
        } finally {
            reporting = false;
        }
    }

    for (const level of levels) {
        const original = console[level]?.bind(console);
        if (!original) continue;
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
            msg: scrub(String(event.message)).slice(0, 2000),
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
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (reporting || url.startsWith(endpoint)) return originalFetch(input, init);
        if (options.ignorePaths?.some((re) => re.test(url))) return originalFetch(input, init);

        const method = (
            init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const path = redactPath(url);
        const startedAt = Date.now();

        try {
            const response = await originalFetch(input, init);
            let body: string | undefined;
            if (
                options.captureBodies &&
                !options.denyBodyPaths?.some((re) => re.test(path)) &&
                // Reading the body consumes the stream, so work on a clone —
                // otherwise the collector would steal the response from the app
                // that asked for it, which is rule 1.
                response.body
            ) {
                try {
                    const text = await response.clone().text();
                    body = scrub(text).slice(0, maxBody);
                } catch {
                    /* opaque, streaming, or already consumed — skip it */
                }
            }
            record({
                t: startedAt,
                kind: "fetch",
                method,
                path,
                status: response.status,
                ms: Date.now() - startedAt,
                body,
                level: response.ok ? undefined : "warn",
            });
            if (!response.ok) void flush(false);
            return response;
        } catch (err) {
            const { msg, name } = describe([err]);
            record({
                t: startedAt,
                kind: "fetch",
                method,
                path,
                status: 0,
                ms: Date.now() - startedAt,
                msg,
                name,
                level: "error",
            });
            void flush(false);
            throw err; // Rule 1: the caller still gets its rejection.
        }
    };

    // The app's own reports. Delivered as DOM events rather than direct calls
    // so `note()` / `screenMessage()` can be imported and used anywhere without
    // the caller needing a handle on this closure — including from code that
    // runs before `observe()` has started, where they simply go nowhere.
    window.addEventListener("__observe_note", (event) => {
        record({
            t: Date.now(),
            kind: "note",
            msg: scrub(String((event as CustomEvent).detail)).slice(0, 2000),
        });
    });
    window.addEventListener("__observe_screen", (event) => {
        record({
            t: Date.now(),
            kind: "screen",
            msg: scrub(String((event as CustomEvent).detail)).slice(0, 2000),
        });
    });
    window.addEventListener("__observe_corr", (event) => {
        correlation = String((event as CustomEvent).detail).slice(0, 120);
        // Send promptly: until this arrives the session cannot be found from a
        // backend log line, which is the main way anybody will look for it.
        void flush(false);
    });

    // pagehide, not unload: bfcache and mobile Safari never fire unload, and
    // mobile Safari is most of what this will run on.
    window.addEventListener("pagehide", () => void flush(true));
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flush(true);
    });
}

/** Record something the app knows and the browser cannot infer. */
export function note(msg: string): void {
    window.dispatchEvent(new CustomEvent("__observe_note", { detail: msg }));
}

/**
 * Record what the USER was actually shown.
 *
 * Console output says what the code thought; this says what appeared on screen.
 * They diverge constantly — a caught error becomes a friendly sentence — and
 * the friendly sentence is what gets reported to you, so it is the one you need
 * in order to find the session somebody is complaining about.
 */
export function screenMessage(text: string): void {
    window.dispatchEvent(new CustomEvent("__observe_screen", { detail: text }));
}

/** Attach the correlation id once the app learns it (after sign-in, etc). */
export function setCorrelation(value: string): void {
    window.dispatchEvent(new CustomEvent("__observe_corr", { detail: value }));
}


/* ── this app's configuration ─────────────────────────────────────────────── */

/**
 * Both values are public and belong in the client bundle. The URL is also in
 * every page's CSP header. The key is WRITE-ONLY: it can append events to this
 * one project and nothing else — it cannot read a session back, list projects,
 * or reach another project's data. Treating it as a secret would be theatre.
 *
 * Not `process.env`: NEXT_PUBLIC_* has to exist at BUILD time, so Cloudflare
 * Workers Builds would need it configured before the collector worked at all —
 * and a missing value fails silently, which is the worst outcome for a logging
 * tool. `connect-src` in middleware.ts must name the same origin or the
 * browser blocks the request.
 */
export const OBSERVE_URL = 'https://ramaaz-observe.yazan-adnof.workers.dev';
export const OBSERVE_KEY = 'pk_root_9afe991c2091264f58cf6987';

/**
 * Starts the collector. Renders nothing.
 *
 * `correlation` arrives as a PROP, from the server. It cannot be read here:
 * the challenge is in an httpOnly cookie precisely so client JS cannot touch
 * it. Passing it down is safe — the challenge ID is an identifier, not a
 * credential; the challenge TOKEN beside it never leaves the server. Without
 * it these sessions carry a random per-tab id and finding the one somebody is
 * complaining about means guessing from timestamps.
 */
export function Observe({ correlation }: { correlation?: string }) {
    useEffect(() => {
        observe({ url: OBSERVE_URL, key: OBSERVE_KEY });
    }, []);

    // Its own effect, keyed on the value: the id arrives after sign-in begins,
    // so it is absent on first render and present on a later one.
    useEffect(() => {
        if (correlation) setCorrelation(correlation);
    }, [correlation]);

    return null;
}

'use client';

/**
 * Browser diagnostics — the whole integration, in one file.
 *
 * GENERATED above the configuration banner from ramaaz-observe's
 * sdk/src/index.ts. Do not edit that part here; run `npm run sync:root` in
 * ramaaz-observe instead, or the next sync silently reverts it.
 *
 * A copy rather than a dependency because the package is not published and the
 * service lives in a private repo: a file: dependency on a sibling checkout
 * builds here and fails on Cloudflare, which only has this repo.
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
    /** Full exchange, when the project opts in. Every value already scrubbed. */
    detail?: {
        reqHeaders?: Record<string, string>;
        reqBody?: string;
        resHeaders?: Record<string, string>;
        resBody?: string;
    };
};

/**
 * Headers that are dropped even when `captureHeaders` is on.
 *
 * Not configurable, and not a judgement call the caller gets to make: these
 * carry credentials by definition, and a logging tool that stores them has
 * turned every log line into a way to impersonate somebody.
 */
const SENSITIVE_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
    "x-step-token",
    "x-csrf-token",
]);

function headersToObject(h: Headers | undefined, max: number): Record<string, string> {
    const out: Record<string, string> = {};
    if (!h) return out;
    h.forEach((value, key) => {
        const name = key.toLowerCase();
        if (SENSITIVE_HEADERS.has(name)) {
            // Recorded as present-but-withheld rather than omitted: knowing a
            // request DID carry auth is usually the point of looking.
            out[key] = "[redacted]";
            return;
        }
        out[key] = scrub(String(value)).slice(0, max);
    });
    return out;
}

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
    /**
     * Also keep request/response HEADERS.
     *
     * ⚠️ Separate from `captureBodies` and off by default, because headers are
     * where credentials live. `Authorization`, `Cookie` and `Set-Cookie` are
     * dropped unconditionally even with this on — see SENSITIVE_HEADERS — but a
     * custom auth header this library has never heard of would come through, so
     * turn it on knowing what your app sends.
     */
    captureHeaders?: boolean;
    /**
     * Never capture a body or headers when the path matches. Checked after
     * redaction, so write these against the redacted form (`/users/[id]`).
     */
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

/**
 * Settings fetched from the service, which the dashboard can change at any
 * time. Starts permissive so the collector works from the first millisecond
 * rather than waiting on a round trip, then narrows when the real answer lands.
 */
type RemoteConfig = {
    enabled: boolean;
    levels?: Array<"log" | "info" | "warn" | "error">;
    captureBodies?: boolean;
    captureHeaders?: boolean;
    captureScreens?: boolean;
    sampleRate?: number;
    denyPaths?: string[];
};

let remote: RemoteConfig = { enabled: true };
let remoteDeny: RegExp[] = [];

/**
 * Snapshot what is on screen.
 *
 * Not a picture — a copy of the DOM. A real screenshot needs html2canvas
 * (~200KB) or a permission prompt, and neither is worth it for something that
 * runs on every page. The markup replays in the dashboard with the app's own
 * stylesheets, which for a form or an error screen is the same information.
 *
 * Scripts are stripped before it leaves, and passwords are emptied: a snapshot
 * of a login screen would otherwise carry whatever was typed into it.
 */
function captureScreen(): string | null {
    try {
        const doc = document.documentElement.cloneNode(true) as HTMLElement;
        for (const el of Array.from(doc.querySelectorAll("script,noscript"))) el.remove();
        for (const el of Array.from(doc.querySelectorAll("input"))) {
            const input = el as HTMLInputElement;
            if (input.type === "password") input.setAttribute("value", "");
            else input.setAttribute("value", input.value ?? "");
        }
        // A <base> so the captured page still resolves its own stylesheets and
        // images when it is framed from a different origin.
        const base = `<base href="${location.origin}">`;
        return `<!doctype html><html>${base}${doc.innerHTML}</html>`.slice(0, 380_000);
    } catch {
        return null;
    }
}

export function observe(options: ObserveOptions): void {
    if (started || typeof window === "undefined") return;
    started = true;

    const endpoint = options.url.replace(/\/$/, "") + "/ingest";
    const base = options.url.replace(/\/$/, "");
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
            if (level === "error") maybeSnapshot(msg);
            record({ t: Date.now(), kind: "console", level, msg, name, stack });
        };
    }

    /**
     * Poll the project's settings.
     *
     * Every sixty seconds, so a toggle in the dashboard reaches a browser that
     * is already open — the whole point of moving settings off the app. A
     * failed poll keeps whatever was last known rather than falling back to
     * defaults, so a blip in the service cannot silently widen what an app
     * captures.
     */
    async function pollConfig() {
        try {
            const r = await originalFetch(`${base}/config/${encodeURIComponent(options.key)}`);
            if (!r.ok) return;
            remote = await r.json();
            remoteDeny = (remote.denyPaths ?? [])
                .map((p) => {
                    try {
                        return new RegExp(p);
                    } catch {
                        return null;
                    }
                })
                .filter((r): r is RegExp => r !== null);
        } catch {
            /* keep the last known settings */
        }
    }

    /**
     * Resolved per call, not once at startup, because the answer changes when
     * the config poll lands. A local option always wins where it is set: an
     * app's own refusal — root excluding its KYC routes — must not be
     * overridable from a web page.
     */
    const capBodies = () =>
        options.captureBodies !== undefined ? options.captureBodies : !!remote.captureBodies;
    const capHeaders = () =>
        options.captureHeaders !== undefined ? options.captureHeaders : !!remote.captureHeaders;

    let lastSnapshot = 0;
    function maybeSnapshot(reason: string) {
        if (!remote.captureScreens) return;
        // At most one every ten seconds. An error loop would otherwise post a
        // few hundred kilobytes per occurrence.
        if (Date.now() - lastSnapshot < 10_000) return;
        lastSnapshot = Date.now();
        const html = captureScreen();
        if (!html) return;
        try {
            navigator.sendBeacon(
                `${base}/snapshot`,
                new Blob(
                    [
                        JSON.stringify({
                            key: options.key,
                            sid,
                            html,
                            viewport: `${innerWidth}x${innerHeight}`,
                            reason: reason.slice(0, 300),
                        }),
                    ],
                    { type: "text/plain" },
                ),
            );
        } catch {
            /* over the beacon size limit, or the page is going away */
        }
    }

    window.addEventListener("error", (event) => {
        maybeSnapshot(String(event.message));
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
        maybeSnapshot(msg);
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

        // One check for the whole exchange: a path worth withholding a response
        // from is a path worth withholding the request from too.
        const denied = (options.denyBodyPaths?.some((re) => re.test(path)) ?? false)
            || remoteDeny.some((re) => re.test(path));

        // Captured BEFORE the call. `init.body` is readable now; after the
        // fetch, a stream body has been consumed and there is nothing to read.
        let reqBody: string | undefined;
        let reqHeaders: Record<string, string> | undefined;
        if (!denied && capBodies() && typeof init?.body === "string") {
            reqBody = scrub(init.body).slice(0, maxBody);
        }
        if (!denied && capHeaders()) {
            const h =
                init?.headers instanceof Headers
                    ? init.headers
                    : init?.headers
                      ? new Headers(init.headers as HeadersInit)
                      : input instanceof Request
                        ? input.headers
                        : undefined;
            reqHeaders = headersToObject(h, maxBody);
        }

        try {
            const response = await originalFetch(input, init);
            let body: string | undefined;
            if (
                capBodies() &&
                !denied &&
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
            const resHeaders =
                !denied && capHeaders()
                    ? headersToObject(response.headers, maxBody)
                    : undefined;
            const detail =
                reqHeaders || reqBody || resHeaders || body
                    ? { reqHeaders, reqBody, resHeaders, resBody: body }
                    : undefined;
            record({
                t: startedAt,
                kind: "fetch",
                method,
                path,
                status: response.status,
                ms: Date.now() - startedAt,
                body,
                detail,
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
                // The request still happened; only the response is missing. A
                // failed call is exactly when you want to see what was sent.
                detail: reqHeaders || reqBody ? { reqHeaders, reqBody } : undefined,
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
    /**
     * Start polling settings.
     *
     * Here, at the end, and not earlier: `pollConfig` uses `originalFetch`, and
     * calling it before that is bound would throw on the very first line the
     * collector runs — taking the page's own console with it.
     */
    void pollConfig();
    setInterval(() => void pollConfig(), 60_000);

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
        observe({
            url: OBSERVE_URL,
            key: OBSERVE_KEY,

            /**
             * ⚠️ `captureBodies` and `captureHeaders` are DELIBERATELY ABSENT.
             *
             * They are now decided in the Observe dashboard, per project, and
             * an option set here would override that — silently, so the toggle
             * would appear to do nothing and the next person would go looking
             * for a bug in the service.
             *
             * The collector fetches the project's settings on start and every
             * minute after, so turning bodies on to chase something takes
             * effect here within a minute and needs no deploy of this app.
             *
             * What stays below is the part that must NOT be switchable from a
             * web page.
             */

            /**
             * ⚠️ The KYC routes, and they are NOT optional.
             *
             * These carry base64 face images, document scans, and responses
             * holding `selfieImageUrl` — a signed S3 link to somebody's face.
             * The scrubber would catch the data URLs and the signed link by
             * shape, but "probably scrubbed" is the wrong standard for
             * biometrics: excluded outright, so there is no pattern to get
             * wrong and nothing to review after the fact.
             *
             * Matched against the REDACTED path, which is what the collector
             * has by this point.
             */
            denyBodyPaths: [/^\/api\/kyc/, /^\/api\/face-capture/],

            /**
             * MediaPipe's on-device telemetry. Blocked by `connect-src` and
             * fails on every face-gate load, so it would otherwise be the most
             * common "error" in the log while meaning nothing.
             */
            ignorePaths: [/googleapis\.com/],
        });
    }, []);

    // Its own effect, keyed on the value: the id arrives after sign-in begins,
    // so it is absent on first render and present on a later one.
    useEffect(() => {
        if (correlation) setCorrelation(correlation);
    }, [correlation]);

    return null;
}

/**
 * Report a failure the USER was shown.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * A Server Action always answers HTTP 200 — the RSC protocol puts the outcome
 * in the body, not the status — so a refusal from the backend reaches the
 * collector looking like a successful request. The evidence that anything went
 * wrong is a sentence on somebody's screen, which nothing records.
 *
 * That happened: a private code was rejected with "That code is not valid.
 * Message the system to get a new one." and the diagnostics showed a clean
 * session, because the action's 200 was the only thing the fetch hook saw.
 *
 * So both halves are sent. `screenMessage` records what the person read, which
 * is the thing they will quote when they report it. The console line carries
 * what the BACKEND said — status, error code, correlation id — which is the
 * thing you need to fix it, and which `signInError` had already flattened away.
 */
export function reportUserError(
    shown: string,
    diag?: {
        status?: number;
        code?: string;
        correlationId?: string;
        backendMessage?: string;
    },
): void {
    screenMessage(shown);

    const real = diag && Object.values(diag).some((v) => v !== undefined);
    if (real) {
        // console.error, not note(): this is a failure, and the collector marks
        // the session as having one. A session that refused somebody's sign-in
        // should not read as clean.
        console.error(
            `[shown to user] ${shown}`,
            {
                status: diag.status,
                code: diag.code,
                correlationId: diag.correlationId,
                backend: diag.backendMessage,
            },
        );
    } else {
        console.error(`[shown to user] ${shown}`);
    }
}

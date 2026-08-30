import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Read a Cloudflare var or secret, wherever it happens to live.
 *
 * ── Why this is not just `process.env` ──────────────────────────────────────
 * A value set with `wrangler secret put`, or written in `.dev.vars`, arrives in
 * the WORKER's env — `getCloudflareContext().env` — and not necessarily in
 * `process.env`. In `next dev` it does not: `initOpenNextCloudflareForDev()`
 * builds the Cloudflare context from `.dev.vars`, and `process.env` never sees
 * it.
 *
 * That gap is easy to miss because `NEST_API_URL` reads fine from
 * `process.env` — but only because it is ALSO in `.env.local`, which Next loads
 * itself. Any secret that lives only in `.dev.vars` reads as `undefined`, and a
 * gate written as `if (!secret) return 404` then fails closed and looks exactly
 * like a wrong password. That cost an afternoon on LIVENESS_LAB_SECRET.
 *
 * Cloudflare first, `process.env` second: the worker env is authoritative where
 * it exists, and the fallback covers `next build`, plain node, and anything
 * supplied through `.env.local`.
 */
export function cfEnv(name: string): string | undefined {
    try {
        const { env } = getCloudflareContext();
        const value = (env as Record<string, unknown>)[name];
        if (typeof value === "string" && value !== "") return value;
    } catch {
        // No Cloudflare context — `next build`, a test, plain node. Fall through.
    }
    const fromProcess = process.env[name];
    return fromProcess && fromProcess !== "" ? fromProcess : undefined;
}

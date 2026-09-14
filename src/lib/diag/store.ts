import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * The DIAG KV namespace, or null when there isn't one.
 *
 * Separate from `cfEnv` because that returns strings — a binding is an object,
 * and coercing one through a string accessor would read as `undefined` and look
 * exactly like a missing namespace.
 *
 * Returning null rather than throwing is deliberate: diagnostics are never
 * allowed to break the thing they are watching. `next dev` without a wrangler
 * session has no binding, and a sign-in must work there regardless.
 */
/**
 * Only what this module calls.
 *
 * Structural, rather than `KVNamespace` from `@cloudflare/workers-types`, for
 * the same reason the KYC proxy types its service binding as
 * `{ fetch: typeof fetch }`: this project does not depend on the workers types,
 * and one KV `put` is not worth making it.
 */
type DiagKV = {
    put(
        key: string,
        value: string,
        options?: { expirationTtl?: number },
    ): Promise<void>;
};

export function diagStore(): DiagKV | null {
    try {
        const { env } = getCloudflareContext();
        const kv = (env as Record<string, unknown>).DIAG;
        // Duck-typed: there is no class here to compare against.
        if (kv && typeof (kv as DiagKV).put === "function") {
            return kv as DiagKV;
        }
    } catch {
        // No Cloudflare context at all — `next build`, plain node.
    }
    return null;
}

/**
 * Key layout: `diag:<challengeId>:<sid>:<seq>`
 *
 * Challenge id FIRST, and that ordering is the whole design. KV lists by
 * prefix, so it is the only thing that makes "show me everything that happened
 * to this sign-in" a single call — and the challenge id is exactly what the
 * backend's own logs quote when somebody reports a failure. Given
 * `01M2GKPBFGNRNY1CNN1PHXYCJS` from a backend log line, the browser side of the
 * same attempt is `diag:01M2GKPBFGNRNY1CNN1PHXYCJS:` and nothing else.
 *
 * `anon` covers events with no challenge yet — /login before a link is opened,
 * /no-access after one died. Worth keeping (a failure there is still a failure)
 * and worth segregating, since it cannot be tied to a person.
 *
 * `seq` is zero-padded so a lexicographic list is also chronological. Without
 * the padding, flush 10 sorts before flush 2 and the record reads out of order.
 */
export function diagKey(challengeId: string | undefined, sid: string, seq: number): string {
    const scope = challengeId && /^[A-Za-z0-9]{1,40}$/.test(challengeId) ? challengeId : "anon";
    return `diag:${scope}:${sid}:${String(seq).padStart(3, "0")}`;
}

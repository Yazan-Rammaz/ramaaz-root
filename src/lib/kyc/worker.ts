import "server-only";

/**
 * Where the `ramaaz-kyc` Worker lives, and who we are to it.
 *
 * One module so the answer is in one place: the proxy route, and anything that
 * needs to reach the Worker later, resolve it here rather than each carrying
 * their own fallback chain.
 */

/**
 * Our tenant id in the Worker's registry.
 *
 * Sent as `X-Ramaaz-Tenant` on every call. Omitting it would resolve to `rdb` —
 * the Worker's default for clients that predate tenants — which would route
 * root's traffic to RDB's backend. It is a constant, not config: this app is
 * root, and could not honestly claim to be anything else.
 */
export const KYC_TENANT = "root";

/**
 * Base URL of the Worker.
 *
 * On Cloudflare this is used only to build the request URL — the actual
 * transport is the `KYC_WORKER` service binding, because a same-account
 * Worker→Worker fetch over `*.workers.dev` never reaches the target. In `next
 * dev` there is no binding, so this URL is fetched directly.
 *
 * Point `KYC_WORKER_URL` at `http://localhost:8787` to develop against a local
 * `wrangler dev` in the ramaaz-kyc repo; leave it unset to use the deployed
 * Worker, which is the common case since the analysis endpoints need no local
 * state.
 */
export function kycWorkerUrl(): string {
  return (
    process.env.KYC_WORKER_URL?.replace(/\/+$/, "") ??
    "https://ramaaz-kyc.yazan-adnof.workers.dev"
  );
}

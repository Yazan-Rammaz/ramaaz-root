import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext → Cloudflare adapter config.
 *
 * ── enableCacheInterception is OFF, deliberately ────────────────────────────
 * It was on, with no incremental cache configured. Interception short-circuits
 * a request inside the worker and answers it from the cache before Next's
 * server runs — useful for ISR/static pages, useless here: every route in this
 * app is dynamic (ƒ) because it reads auth cookies, and there is no cache
 * backend for it to read from.
 *
 * The cost was real. Deployed responses carried `no-store` where local ones
 * carried only `no-cache, must-revalidate`, so the router could not keep any
 * prefetched RSC payload and re-fetched every nav link on each navigation
 * (visible as repeated `?_rsc=` requests, and full reloads that re-showed the
 * splash). It reproduced on the worker only, because this layer does not exist
 * in `next dev`.
 *
 * Turn it back on only alongside a real incrementalCache (KV or R2) AND routes
 * that are actually cacheable.
 */
export default defineCloudflareConfig({});

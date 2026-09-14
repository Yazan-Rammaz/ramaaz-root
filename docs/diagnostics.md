# Diagnostics — reading a failure after the fact

## The problem this solves

Three of the four sides of a sign-in were already readable, and the fourth was
the one that mattered.

| Side | Where its logs go | Readable later? |
| --- | --- | --- |
| `control-panel` (backend) | its own access log | yes |
| `ramaaz-kyc` (Worker) | Workers Logs | yes |
| `canroot` (this app, server) | Workers Logs | yes |
| **the browser** | `console.error` on somebody's tablet | **no — gone on tab close** |

A face check failed on a tablet showing "Could not start the face check".
Establishing why took reading four repositories and a backend log pasted by
hand, and still did not produce the answer — because the one line naming the
cause, `[liveness] detector error`, had run in a browser with no console
attached. The camera lives in the browser, so the camera's failures do too.

This ships that line to the server instead.

## Reading a record

```bash
npm run diag -- list                    # every sign-in that has a record
npm run diag -- list <challengeId>      # the individual flushes for one
npm run diag -- show <challengeId>      # the whole record, in order
```

`show` prints what the browser saw:

```
── diag:01M2GKPBFGNRNY1CNN1PHXYCJS:9f3c…:000  (2026-09-15T00:14:22Z)
   Mozilla/5.0 (iPad; CPU OS 17_5 …)  1024x768x2
   18:46:34.021  fetch  POST /api/kyc/reverify/start → 200 (412ms)
   18:46:36.883  error  [CAMERA_FRAMERATE_ERROR] [liveness] detector error
```

**The challenge id is the join.** It is what the backend quotes in its own log
lines, so a report of the form "challenge `01M2GKPBFG…` failed" is enough to
pull the browser side of the same attempt. No timestamp hunting, no guessing
which session was whose.

Events with no challenge yet — `/login` before a link is opened, `/no-access`
after one died — are filed under `anon`.

Records live **30 days**, then expire on their own.

## What is captured, and what is not

Metadata only, and the schema in `src/lib/diag/events.ts` is the enforcement:

- console `warn` / `error`, with the error's `name` and stack
- uncaught errors and unhandled rejections
- every `fetch`: method, redacted path, status, duration
- user agent and screen geometry — the camera failures are device-shaped

There is **no field** for a request body, a response body, or a header. Not
filtered — absent. So there is nowhere for a face image, a challenge token, a
private code, a Bearer token or a signed S3 URL to land, and no future change
can leak one by forgetting to add a key to a denylist. Adding such a field is a
deliberate act and should be argued for in review.

`path` is the one field that could still carry a credential, because
`/enter/<token>` puts the access-link token in a URL path. `redactPath` strips
the query string entirely and replaces opaque-looking segments with `[token]` /
`[id]`. It runs **twice** — in the browser before sending, and again in the
route before storing, because the browser is not a trusted place to enforce a
rule about credentials.

## How it fits together

```
browser                          canroot                     KV
──────────────────────────────   ─────────────────────────   ──────────────
console.error / fetch / onerror
  → collector buffers            POST /api/diag
  → flush every 10s, on failure    reads challengeId from    diag:<challenge>:
    and on pagehide (sendBeacon)   the httpOnly cookie        <sid>:<seq>
                                   console.log(summary) ────► Workers Logs
```

- `src/lib/diag/events.ts` — schema, limits, `redactPath`
- `src/lib/diag/collector.ts` — the browser hooks
- `src/lib/diag/store.ts` — the KV binding and key layout
- `src/app/api/diag/route.ts` — the sink
- `src/components/diag/DiagnosticsMount.tsx` — mounted in the root layout

The challenge id is read from the httpOnly cookie **server-side** and never
sent by the client, so a bundle cannot be filed against somebody else's
sign-in.

## Things worth knowing

**It never breaks the page.** Every hook calls through to the original and
returns what it returned; a failed report is silently dropped rather than
logged, because logging it would hit our own console hook and loop.

**`/api/diag` always answers 204**, including when it rejects the body. It is
reachable before authentication, so a distinguishing reply would tell a prober
whether a challenge id is real.

**Write budget.** Each flush is one KV write. The collector batches on a 10s
timer and stops after 20 flushes per session, so a normal sign-in costs a
handful. Cloudflare's free plan allows 1,000 KV writes/day per account — worth
watching if this account is on free and the console gets busy.

**It is unauthenticated.** Size and event caps bound what one caller can store,
and the TTL bounds how long, but someone holding a link could still write junk
records. That was the deliberate trade: the failures worth catching happen
before there is a session to authenticate with.

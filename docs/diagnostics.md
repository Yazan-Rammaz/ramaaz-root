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
hand, and still did not produce the answer — because the line naming the cause,
`[liveness] detector error`, had run in a browser with no console attached. The
camera lives in the browser, so the camera's failures do too.

It turned out to be `MOBILE_LANDSCAPE_ERROR`: the tablet was sideways, and AWS
Face Liveness refuses to run in landscape on mobile.

## Where to read it

**https://ramaaz-observe.yazan-adnof.workers.dev** — a web page, with filters.

Open it once with the admin key (`/login?key=…`); it becomes a cookie. Pick a
session, read its timeline: every request with status and duration, every
console error, every message the user was actually shown.

Search by **challenge id**. That is the join — it is what `control-panel` quotes
in its own log lines, so a report of the form "challenge `01M2GKPBFG…` failed"
finds the browser side of the same attempt with no timestamp hunting.

The store, the dashboard and the SDK live in
[`ramaaz-observe`](https://github.com/Yazan-Rammaz/ramaaz-observe).

## How this app is wired

```
browser                     canroot                        ramaaz-observe
─────────────────────────   ────────────────────────────   ────────────────
console.error / fetch
  → collector buffers       POST /api/diag
  → flush every 10s, on       reads challengeId from the
    failure, and on           httpOnly cookie
    pagehide (sendBeacon)     forwards with OBSERVE_KEY ──► D1 + dashboard
```

- `src/lib/diag/events.ts` — schema, limits, `redactPath`
- `src/lib/diag/collector.ts` — the browser hooks
- `src/app/api/diag/route.ts` — forwards to `ramaaz-observe`
- `src/components/diag/DiagnosticsMount.tsx` — mounted in the root layout

### Why this app forwards instead of posting straight there

The SDK can post cross-origin, and on Vercel or Pages that is how it should be
used. Not here:

1. **`connect-src 'self'`** (`middleware.ts`) forbids this browser from talking
   to any origin but ours, and that restriction is load-bearing — it is what
   stops a tampered page from shipping a camera frame somewhere. Relaxing it to
   admit a logging host would spend a real security property on convenience.
2. **Only the server has the correlation id.** The challenge id is in an
   httpOnly cookie precisely so client JS cannot read it, so the browser could
   never label its own session with the id the backend logs quote.

`OBSERVE_URL` and `OBSERVE_KEY` are Cloudflare **secrets**, not vars — a `vars`
entry would shadow a secret of the same name and commit the key.

## What is captured, and what is not

Metadata only, and the schema in `src/lib/diag/events.ts` is the enforcement:
console `warn`/`error` with error names and stacks, uncaught errors, unhandled
rejections, and every `fetch` (method, redacted path, status, duration).

There is **no field** for a request body, a response body, or a header. Not
filtered — absent. So a face image, challenge token, private code or signed S3
URL has nowhere to land, and no future change leaks one by forgetting a denylist
entry. Adding such a field is a deliberate act and should be argued for.

`path` is the one field that could still carry a credential, because
`/enter/<token>` puts the access-link token in a URL path. `redactPath` strips
query strings entirely and replaces opaque segments. It runs **twice** — in the
browser and again in the route — because the browser is not a trusted place to
enforce a rule about credentials.

## Things worth knowing

**It never breaks the page.** Every hook calls through to the original and
returns what it returned; a failed report is dropped silently rather than
logged, because logging it would hit our own console hook and loop.

**`/api/diag` always answers 204**, including when it rejects the body. It is
reachable before authentication, so a distinguishing reply would tell a prober
whether a challenge id is real.

**Unconfigured is not broken.** With `OBSERVE_URL`/`OBSERVE_KEY` unset the route
warns once and drops the events. A sign-in works whether or not logging does.

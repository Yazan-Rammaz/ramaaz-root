# KYC integration

Face verification and ID enrolment span three services. Nothing here works until
all three agree, so these pages exist to make the seams explicit.

```
┌─────────┐   httpOnly cookie   ┌───────────┐   X-Step-Token   ┌────────────┐
│ Browser │ ──────────────────► │ Dashboard │ ───────────────► │ ramaaz-kyc │
└─────────┘    (same origin)    └───────────┘                  └─────┬──────┘
                                                                     │
                                          X-Internal-Secret          │
                                          Bearer + X-KYC-Signature   │
                                               ┌─────────────────────┘
                                               ▼
                                       ┌───────────────┐
                                       │ Root backend  │  ← decides pass/fail
                                       └───────────────┘
```

**The browser decides nothing, and the Worker decides nothing.** The Worker
measures — liveness 94.2, face match 91.7 — and reports those numbers over a
signed server-to-server channel. The backend applies the thresholds and owns the
verdict.

That is not a preference. KYC sits on the login path: a pass/fail computed in the
browser could be forged from devtools, and one computed in the Worker and
relayed through the browser is no better.

---

## Pages

### [Root backend — what to build](backend.md)

**For the root backend developer.** The four endpoints root's flow reaches, the
three things that will silently break it, and the decisions still open. This is
the page to send.

### [Worker contract](worker-contract.md)

**The canonical contract**, identical for every Ramaaz product. Auth model, HMAC
rules, the full endpoint list, and how a new product is registered.
Source of truth lives at `frontend/ramaaz-kyc/INTEGRATION.md`.

### [Design note — signed result token](signed-result.md)

**Proposed, not built.** How to make `ramaaz-kyc` a genuinely isolated service
that anything can integrate, by having it return a signed receipt instead of
calling back into each consumer's backend. Recorded so the reasoning survives;
the migration is deliberately deferred.

---

## The short version, if you read nothing else

- **One contract for every product.** Same paths, same shapes, same auth. Only
  the *order* a product calls them in may differ, and order lives in that
  product's backend because the Worker keeps no state.
- **Three endpoints need nothing.** `analyze-id`, `liveness` and `compare-face`
  require no auth, no backend and no credentials. A new product can build its
  entire capture UI against them before its backend exists.
- **Two secrets, not one.** `KYC_INTERNAL_SECRET` protects reads;
  `KYC_SHARED_SECRET` protects verdicts. If the second leaks, an attacker can
  forge a passing face check.
- **The face image never reaches the auth backend.** It goes to the Worker; the
  backend receives a verdict.

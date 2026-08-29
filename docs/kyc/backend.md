# Root backend — what to build for KYC

**For the root backend developer.**

> **Read `ramaaz-kyc/INTEGRATION.md` first.** That is the canonical contract —
> the auth model, the HMAC rules, the full endpoint list, and how a product is
> registered. It applies to every Ramaaz product identically.
>
> This file is only the **root-specific** part: which of those endpoints root's
> flow actually reaches, and the decisions still open.

Verified against the running systems on 2026-08-26.

---

## 1. The shape of it

Three parties. The dashboard proxies to the `ramaaz-kyc` Worker; the Worker
measures with AWS Rekognition and reports the numbers to **you**; you apply the
thresholds and own the verdict. The browser never decides anything, and neither
does the Worker.

Root is registered in the Worker as tenant `root`, so the dashboard sends
`X-Ramaaz-Tenant: root` and the Worker routes to your base URL with root's own
signing secrets. Nothing about RDB is involved.

**Root is a mid-login flow.** There is no access token while KYC runs — the
dashboard sends the challenge token as `X-Step-Token`, which the Worker
forwards to you as `Authorization: Bearer`. Every consequence below follows
from that.

---

## 2. The flow

```
liveness            → faceImageData                        (Worker only, no backend)
reverify/verify     { challengeId, liveFaceImageData }      → YOU decide → stepToken
analyze-id (front)  → idFaceImageData                       (Worker only, no backend)
analyze-id (back)                                           (Worker only, no backend)
compare-face        { the frame from step 1, idFaceImageData }   (Worker only, no backend)
submit              full enrolment payload                  → YOU
```

Two things worth noting: the face captured in step 1 is **reused** in step 5, so
the administrator never captures their face twice; and four of the six steps
never reach you at all.

### The face step, in order

This is the one that touches you most, and the order is why `validate` has to
return the photo rather than the Worker fetching it later:

```
dashboard ──live frame──► ramaaz-kyc
                              │
   1.  POST /v1/kyc/reverify/{challengeId}/validate   X-Internal-Secret
       → { valid, selfieImageUrl }
   2.  GET  <selfieImageUrl>          plain fetch, NO Authorization header
   3.  Rekognition CompareFaces       live frame ↔ the stored photo
   4.  POST /v1/kyc/reverify/step/commit    Bearer + X-KYC-Signature
       → { status, reason?, stepToken? }          ← YOUR decision
                              │
dashboard ◄──stepToken────────┘   posted to /v1/auth/face, stage advances
```

The Worker measures; you decide. Step 2 is a plain unauthenticated download,
which is requirement A below.

Before it captures anything, the dashboard runs its own gate — one face,
centred, facing the camera, lit, sharp and still, held for over a second. So a
frame only reaches step 1 when it is worth spending a Rekognition call and, more
importantly, worth spending one of the challenge's five attempts.

---

## 3. What you must implement

Four endpoints. Auth mechanisms and HMAC verification rules are in
`INTEGRATION.md` §3.1 — they are not repeated here.

**You do NOT need `/v1/countries`.** The Worker sends the country as an ISO-3
code (`nationalityCountryIso3`, e.g. `SYR`) inside the submit payload; resolve
that against your own tables. See `INTEGRATION.md` §3.3 for why the old
name-lookup endpoint is deprecated.

### Required

| # | Method | Path | Auth | Notes |
| --- | --- | --- | --- | --- |
| 1 | `POST` | `/v1/kyc/reverify/{challengeId}/validate` | `X-Internal-Secret` | Body `{ userId }` → `{ valid, selfieImageUrl }` |
| 2 | `POST` | `/v1/kyc/reverify/step/commit` | signed + bearer | `{ challengeId, livenessConfidence, faceMatchScore, timestamp, nonce }` → `{ status, reason?, stepToken? }` |
| 3 | `POST` | `/v1/media/upload/direct` | bearer | multipart `file` + `type` → `{ url }`. Called **3×** by submit |
| 4 | `POST` | `/v1/kyc/submit` | signed + bearer | The enrolment record — see the note on its selfie below |

### Only if root later uses the session-based enrolment routes

| # | Method | Path | Auth |
| --- | --- | --- | --- |
| 5 | `GET` | `/v1/kyc/current` | bearer |

Root's flow does not call it — **provided requirement A below is met.**

---

## 4. Four things that will silently break this

**A. `validate` must return `selfieImageUrl`, and it must be plain-fetchable.**

The Worker needs the enrolled reference photo to compare the live face against.
It has two sources: `selfieImageUrl` from endpoint 1, or `GET /v1/kyc/current`.
**Mid-login the second one cannot work** — the bearer is a challenge token,
which will not pass a session guard, so `/v1/kyc/current` 401s and the Worker
reports `NO_ENROLLED_SELFIE`.

So endpoint 1 must return the URL, and it must be a **public or presigned URL**
the Worker can fetch with no Authorization header. An API path behind your auth
will fail.

**B. The challenge token must be accepted on endpoint 3.**

`/v1/media/upload/direct` is called with
`Authorization: Bearer <challenge token>` during `/v1/kyc/submit`, because that is
the only credential that exists mid-login. If it requires a full session,
enrolment fails at the upload step — after the face check has already passed,
which is the worst place to fail.

**C. The token must be a JWT.** See §5.

**D. The selfie in `/v1/kyc/submit` has already been checked twice.**

It is the SAME frame from the face step — not a fresh capture. By the time it
reaches you it has passed the dashboard's local gate and been matched against
the stored photo by Rekognition. The ID enrolment then compares that same frame
against the photo on the document, so all three images agree transitively.

Two consequences: the administrator never captures their face twice, and you do
not need to re-derive anything about that image — its provenance is the face
step you already signed off.

---

## 5. Who stores the images

**You do. The Worker stores nothing, ever.**

It is stateless and shared between products, so storing biometrics would make
it a data controller for users it has no relationship with — per-tenant
buckets, retention rules, deletion-on-request, for products it knows nothing
about.

You receive the images on one endpoint and their URLs on another:

| Endpoint | Receives | Returns |
| --- | --- | --- |
| `POST /v1/media/upload/direct` | **raw bytes** — multipart `file` + `type` | `{ url }` |
| `POST /v1/kyc/submit` | **URLs only**, no image data | the KYC record |

The Worker calls upload three times — front, back, selfie — then puts the URLs
it got back into the submit payload as `documentFrontImageUrl`,
`documentBackImageUrl` and `selfieImageUrl`. `type` is `document` for the two ID
sides and `image` for the selfie.

This is not really a choice. On every LATER login the Worker asks
`/v1/kyc/reverify/{id}/validate` and you answer with `selfieImageUrl` — the
stored photo to compare the live face against. If the Worker had kept it, you
would have nothing to hand back. Storage location is forced by requirement A.

### ⚠️ TODO — which photo becomes the reference?

After enrolment there are two images of the same person: the one seeded at
account creation, and the selfie captured during enrolment.

**We suggest the enrolment selfie** — it was captured live, quality-gated, and
matched against both the seeded photo and the ID. But it is your call, and
`validate` must return whichever you pick.

---
## 6. Decisions

**1. ⚠️ OPEN, AND YOURS TO MAKE — the challenge token must become a JWT.**

The Worker identifies the user by decoding the bearer as a JWT and reading
`sub` (`jwtSub()`, `routes/kyc.ts`). Root's challenge token is opaque — 43
base64url characters, no dots. Probed on the live Worker:

```
X-Step-Token: <JWT with sub>   → reached the backend call
X-Step-Token: <opaque token>   → 401, rejected before the backend was contacted
```

**This is a backend-only change.** You mint the token — `/v1/auth/link` returns
`challenge_token` — so you are the only one who can change its format. Issue it
as a signed JWT carrying at least `sub` (the administrator's user id) and `exp`.

Nothing else moves: the dashboard treats the token as an opaque string, stores
it and forwards it, and never parses it. The Worker already reads JWTs. It is
already single-use and rotating, so signing costs nothing operationally.

**This blocks everything else.**

**2. ✅ SETTLED — a reference photo will be seeded before testing.**

Requirement A depends on it: the face step compares the live face against this
photo, and `validate` must return its URL.

**3. ✅ SETTLED — everything is under `/v1`.**

The tenant's `baseUrl` is now `https://staging-backend.ramaaz.store/v1`, so the
paths in §3 land as `/v1/kyc/reverify/{id}/validate`,
`/v1/kyc/reverify/step/commit`, `/v1/kyc/submit`, `/v1/media/upload/direct` and
`/v1/countries?limit=100`. Config change already made on our side; build them
under `/v1`.

**4. ⚠️ TODO — issue a stable `challenge_id`.**

Return a `challenge_id` alongside the stage, on the `/v1/auth/link` response and
on every step after it. Same value for the whole login attempt.

We pass it to the KYC Worker, which hands it back to you at
`POST /v1/kyc/reverify/{challengeId}/validate` so you can confirm the face check
belongs to an open attempt and return that user's `selfieImageUrl`.

**It must be a separate value from `challenge_token`.** The token rotates on
every step by design — each response issues a new one and kills the old — so it
cannot correlate anything. A lookup key has to be stable for the whole attempt.
It is an identifier, not a credential, so it is fine in a request body and in
logs.

Until it exists the face check fails at the Worker with
`422 challengeId is required`, before reaching you.

**7. ✅ AGREED — collapse ID_DOCUMENT and ID_INFO into one stage.**

One `/v1/kyc/submit`, one stage, one step token. Drop `ID_INFO_REQUIRED`.

A stage exists to say "the server is blocked until you send something". There
is no second user interaction here: the Worker OCRs the document, the summary
screen shows the extracted fields, the person confirms them, and ONE submit
carries images and fields together. Nothing is left for `ID_INFO` to gate —
keeping it would mean the dashboard auto-posting a second token representing no
user action at all.

The original split came from `root-enrollment.md`, where both steps were stubs
and the administrator was expected to TYPE their ID details. OCR removed that
step, and that document already said those evidence shapes were "a suggestion,
not a contract".

**Do not let `/kyc/submit` advance the challenge itself.** `/v1/auth/*` is the
single door into the state machine; a second path mutating it means two
authorities on flow position. It would also teach the Worker about auth stages,
which is the coupling the signed-result design note argues for removing.

Accepted consequence: you can no longer reject the DETAILS separately from the
DOCUMENT. The summary screen already covers that with "Incorrect, Try Again",
which is a client-side retry before submitting, not a stage.

On our side this is one line — `STAGE_ROUTES` already routes both stages to the
same screen.
**5. ✅ SETTLED — "is this a first login?" is the STAGE, not a flag.**

Please do **not** add a `needsEnrollment` or `isFirstLogin` field. After the face
check passes, the stage you return already carries it:

| You return | Means | We go to |
| --- | --- | --- |
| `ID_DOCUMENT_REQUIRED` | first login | ID enrolment |
| `DEVICE_REQUIRED` / `COMPLETED` | returning | passkey, then the dashboard |

One state machine. A second source of truth about who is new is a bug waiting
to happen, and this one is already correct.

**6. How does the result satisfy `FACE_REQUIRED`?**

`step/commit` returns a `stepToken`. Our proposal: the dashboard posts it to
your existing `POST /v1/auth/face` as `evidence: { step_token: "…" }`, you
verify the token you just minted, and advance the stage. That keeps
`/v1/auth/*` the single door into the challenge state machine.

It also settles the open question about `evidence` field names, and has a
consequence worth stating plainly: **the face image never reaches you.** It goes
to the Worker. You never store or handle a biometric image on the auth path.

---

## 7. The two secrets — we have to agree on the values

Nothing signs until these match on both sides. Either of us can generate them;
they just have to be the same string, and they must be **two different values**:

| Secret | Protects | If it leaks |
| --- | --- | --- |
| `KYC_INTERNAL_SECRET` | the `validate` lookup (endpoint 1) | an attacker can probe challenge ids and read back `selfieImageUrl` — read-only, but biometric |
| `KYC_SHARED_SECRET` | the signed commits (endpoints 2 and 5) | an attacker can **forge a passing face check** — with any valid bearer, that is account takeover |

That difference is why there are two. Collapsing them into one value means every
routine read carries the key that can forge verdicts.

Suggested: 32 random bytes, base64. Send them over something that is not chat —
we set them on the Worker as `KYC_SHARED_SECRET_ROOT` and
`KYC_INTERNAL_SECRET_ROOT`, scoped to root alone, so RDB can never mint a
verdict root would honour.

Until they are set, `GET /ready` on the Worker reports root as
`"sharedSecret": false, "internalSecret": false` and every signed call answers
503. That endpoint is the fastest way to confirm the wiring.

---

## 8. Known, already being fixed

`POST /v1/auth/link` returns **500** for a real access link:

```
{"error":{"code":"INTERNAL_ERROR","message":"Something went wrong on our side...",
          "correlation_id":"01M0Z0FHB6VAR1W29B220DSK6H"}}
```

Also `01M0Z0FJWZ3SPN0S0SDF01P1K4`. Same result with and without `device_label`,
so it is not a request-shape problem. A spent token and pure garbage both answer
a clean `401 UNAUTHENTICATED`, so the link record is **found and then crashes**.

Nobody can sign in at all until this is fixed, KYC or otherwise — but it is
already known and in progress, so it is recorded here only so the correlation
ids are not lost.

---

## 9. What is already built on our side

The whole capture UI: document scanner (OpenCV), liveness (MediaPipe), face
match, ID summary, re-verify. It typechecks and runs today against a mock
service with every failure branch reproducible.

The three analysis endpoints (`analyze-id`, `liveness`, `compare-face`) need no
auth and no backend, so steps 1, 3, 4 and 5 of §2 can be built and tested
against real AWS **before you write anything**. Only steps 2 and 6 wait on you.

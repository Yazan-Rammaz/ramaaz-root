# Restoring an in-flight sign-in after a refresh

**Status:** specified, not built. Waiting on the Nest backend.

## The problem

Everything the KYC sub-flow knows lives in React state, in one tab:

| What | Where | Survives refresh |
| --- | --- | --- |
| `livenessResult.faceImageData` | `VerificationContext` state | ✗ |
| `idDocument` (front/back images, OCR) | `VerificationContext` state | ✗ |
| `completedSteps` | `VerificationContext` state | ✗ |
| `currentStep` | `VerificationContext` state | ✗ (re-seeded from the server stage) |

So a refresh on `/login/identity` drops the captured face. That is not cosmetic:
`FaceMatchScreen` needs the frame to run the ID-vs-face comparison, and without
it the submit is skipped entirely.

The resume effect already in `VerificationContext` (T037) cannot help — it keys
off `completedSteps`, which is also state, so after a reload it returns early on
`completedSteps.size === 0` and does nothing.

The server stage IS restored on refresh (`applyStage` → the challenge cookie →
`STAGE_ROUTES`), which is why the user lands back on the right screen. It is only
the data captured *within* the stage that is lost.

## The decision

The Nest backend stores the in-flight step data against the challenge token, with
an expiry, and the frontend restores from it on mount.

Chosen over the two alternatives deliberately:

- **Browser storage** (localStorage / sessionStorage / IndexedDB) — refused. The
  existing rule is in `lib/auth/endpoints.ts` on `STAGE_ROUTES`: the frame is
  "far too large for a cookie, and biometric data we will not put in browser
  storage." It also would not survive the WhatsApp in-app-browser → Chrome
  hand-off, which is the case that started all of this.
- **Re-fetching from the KYC Worker**, which already holds the frame it judged.
  Adds no new biometric store and needs no auth-backend change, but it only
  restores the face — not the ID images, the OCR result, or which steps are
  done. The backend store covers all of it.

⚠️ **This reverses an explicit invariant, knowingly.** `/v1/auth/face` takes
`{ step_token }` and never pixels, and `AUTH_PATHS.identityDocument` is mid
-migration to the same shape *because* "every argument for keeping the selfie out
of the auth backend applies to it with more force" (`endpoints.ts`). Storing step
data that includes a face image puts a biometric on the auth path. That is the
owner's call and it is made; it is recorded here so nobody later reads it as an
oversight.

## What the frontend needs

Two calls, both scoped to the live challenge and both authenticated the way every
other step is — `challenge_token` in the body, exactly as
`privateCodeRequestSchema` and `evidenceRequestSchema` do. No new auth scheme.

### `POST /v1/auth/step-state`

Save. Called after each capture completes.

```jsonc
{
  "challenge_token": "…",
  "step": "ID_DOCUMENT_REQUIRED",   // the server stage this belongs to
  "data": { }                        // opaque to the backend — see below
}
```

### `GET /v1/auth/step-state`

Restore. Called once when the identity flow mounts.

```jsonc
{
  "step": "ID_DOCUMENT_REQUIRED",
  "data": { },
  "saved_at": "2026-09-11T14:02:11Z"
}
```

Empty/404 when nothing is stored — the frontend treats that as "start this stage
clean", which is exactly today's behaviour, so shipping the endpoint late breaks
nothing.

### Requirements

1. **Opaque `data`.** The backend stores and returns it unchanged. The shape is
   the frontend's (`faceImageData`, `idDocument`, `completedSteps`), and pinning
   it server-side would mean a backend release every time a screen changes.
2. **Dies with the challenge.** Same TTL as `AUTH_CHALLENGE_TTL` (10 min), and
   deleted outright when the challenge completes, expires, or burns. It must
   never outlive the sign-in it belongs to — this is a face image.
3. **Size.** A face frame is ~300KB base64; two ID images take the realistic
   ceiling to ~1MB. Confirm that is acceptable, or say so and we will downscale
   before sending.
4. **Scoped to the challenge, not the account.** A token restores only its own
   attempt. Two concurrent sign-ins must not see each other's data.
5. **Not returned by `/v1/me`** or any post-sign-in route. It is challenge
   scratch space and nothing else should surface it.

## Wiring, once it exists

- `VerificationContext` — restore on mount (before the T037 resume effect, which
  then works for the first time because `completedSteps` is populated).
- Save on: liveness pass (`onFaceCaptured`), ID capture, OCR confirm.
- `FaceMatchScreen` — the "photo was lost when the page reloaded" branch becomes
  unreachable and should be deleted with it.

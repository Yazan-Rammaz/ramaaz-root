# Admin identity verification — flow spec

What the screens do, every branch they can take, and **exactly what the backend
has to provide**. Written to be reviewed before the API is agreed: the last
section is the checklist to fill in.

Companion to `PORTING.md`, which covers how this feature got here from rdb.

---

## 1. The flow

Two paths. The difference is one server fact: has this admin enrolled yet?

```
private code → password → WhatsApp OTP → passcode
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │ face-reverify │   live face vs the photo
                                    └───────┬───────┘   the backend already holds
                                            │
                         enrolled ──────────┴────────── never enrolled
                              │                              │
                              ▼                              ▼
                          dashboard              intro → id-capture-front
                                                       → id-capture-back
                                                       → id-summary
                                                       → face-detection (liveness)
                                                       → face-match (live face vs ID photo)
                                                       → success → dashboard
```

The first four steps already exist and are unchanged. Everything from
`face-reverify` down is this feature.

**`face-reverify` and `face-match` are different steps.** Re-verify compares the
live face against the **stored reference photo** and runs on every sign-in.
Match compares the live face against the **photo on the ID just scanned** and
runs only during enrolment. Same visual language, different question.

### The rule the whole design hangs on

**The browser decides nothing.** Each screen captures, posts, and waits. The
backend returns a **step token**; the flow advances only on that token.

This is not a style preference. rdb's KYC lived *inside* an authenticated app,
so a forged client-side pass got you nothing the user didn't already have. Here
the flow sits **on the login path** — a pass/fail computed in the browser could
be forged from devtools and would mean walking straight into the dashboard.
`IKycService.submitReverify` already documents this ("the pass/fail decision is
made ONLY in NestJS") and already returns `stepToken`.

---

## 2. Screens

| Step | Component | What it does |
| --- | --- | --- |
| `face-reverify` | `FaceReverifyScreen` | One live frame → compare to stored photo. 3 attempts, then `contact-support`. **New — written for this flow.** |
| `intro` | `IntroScreen` | Enrolment explainer + consent. |
| `id-capture-front` / `id-capture-back` | `IDCaptureScreen` | OpenCV document scanner finds the card edges, auto-captures when stable. |
| `id-summary` | `IDSummaryScreen` | Extracted fields for review before submit. |
| `face-detection` | `AwsFaceLiveness` | 3 liveness challenges (straight / right / left) via MediaPipe. |
| `face-match` | `FaceMatchScreen` | Live face vs the photo on the ID. |
| `success` | `SuccessScreen` | Enrolment complete. |
| `contact-support` | `ContactSupportScreen` | Attempts exhausted. |

Entry point is `IdentityGate` (`components/IdentityGate.tsx`), mounted by
`app/(auth)/login/identity/page.tsx`. It picks the opening step and decides what
happens after the face check passes.

---

## 3. Failure scenarios

All of these run **with no backend**. `MockKycService` covers every branch. In
the browser console:

```js
localStorage.setItem('kyc_mock_scenario', 'reverify-fail'); location.reload()
```

| Scenario | Proves |
| --- | --- |
| `happy` (default) | Full path end to end. |
| `reverify-fail` | Wrong face at the login gate → retry, 3 attempts, then `contact-support`. **Nothing advances** — the screen never receives a `stepToken`. |
| `liveness-fail` | Liveness rejects the frame → challenge restarts with guidance. |
| `id-wrong-side` | Back shown during the front step → corrective message, no capture. |
| `id-unreadable` | Glare/blur → "hold the card flat", stays on the step. |
| `match-fail` | Live face ≠ ID photo → enrolment rejected. |
| `match-review` | Score in the 85–89 manual-review band → neither pass nor hard fail. |

Reset with `localStorage.removeItem('kyc_mock_scenario')`.

### Cases the backend has to arbitrate, not the client

These can't be mocked meaningfully because the answer is a server decision:

- **Reference photo missing.** An admin with no stored photo hits a gate that
  cannot pass. Either provision the photo up front, or the flow must fall back
  to enrolment. **Undecided.**
- **Challenge expired.** The login flow's step tokens are short-lived. If the
  admin leaves the camera open too long, re-verify must fail closed and send
  them back to the start.
- **Attempts across sessions.** 3 attempts is currently per-mount. A refresh
  resets it. Real lockout has to be counted server-side.

---

## 4. What I need from you

The frontend is finished and typechecks clean. Everything below is a slot with a
mock in it.

### 4a. Base URL and transport

`services/kycApi.ts` posts to same-origin `/api/kyc/*`, because the browser is
not allowed to call a backend directly (AGENTS.md §2). A route handler at
`app/api/kyc/[...path]/route.ts` forwards them with the auth cookie attached.
**Not written yet** — it needs your base URL.

Paths currently assume the existing `ramaaz-kyc` Worker (`app.route('/api/kyc',
kycRoutes)`). If yours differ, `PATHS` in `kycApi.ts` is the only thing to edit.

### 4b. Endpoints

| Purpose | Assumed path | Request | Response the UI reads |
| --- | --- | --- | --- |
| Open face check | `POST /api/kyc/reverify/start` | `{ challengeId }` | `{ sessionId, region }` |
| Submit face check | `POST /api/kyc/reverify/verify` | `{ challengeId, liveFaceImageData }` | `{ status: 'passed' \| 'failed' \| 'error', stepToken?, reason?, faceMatchScore? }` |
| Liveness frame | `POST /api/kyc/liveness` | `{ faceImageData, challengeStep, crop }` | `{ isLive, faceImageData?, metrics? }` |
| Read ID side | `POST /api/kyc/analyze-id` | `{ imageData, side, sessionHint }` | `{ status, code?, message?, nextStep?, extractedData? }` |
| Face vs ID | `POST /api/kyc/compare-face` | `{ selfieImageData, idFaceImageData }` | `{ status, matchScore?, message? }` |
| Open enrolment session | `POST /api/kyc/session` | — | `{ sessionId, expiresAt }` |
| Read KYC state | `GET /api/kyc/status` | — | `{ status }` |
| Submit enrolment | `POST /api/kyc/submit` | `SubmitVerificationPayload` | `{ success, kycRequest? }` |

Exact shapes are typed in `services/kycApi.ts` and `services/kycService.interface.ts`.

### 4c. Three things that are not endpoints

**1. Is this admin enrolled?** `IdentityGate` takes `needsEnrollment`, currently
hardcoded `false`. It should come from the session — the cleanest place is a KYC
status on `/auth/me`, so the dashboard's own gate can check the same fact.
`KycVerificationStatus` in `types/verification.ts` guesses the values
(`not_started` / `pending` / `verified` / `rejected`) — **confirm these strings**.

**2. Where does `challengeId` come from?** It binds a face check to one login
attempt. It should be issued with the passcode step's token and ride in the
`rdb_login_flow` cookie, like `unlockToken` does now. Currently `"preview"`.

**3. What does the step token buy?** After the face check passes, something has
to turn that token into a session. Today the passcode step still completes the
login on its own, so this page gates nothing — deliberately, so that a
half-wired identity step can't lock anyone out. Wiring it means adding a step to
`lib/auth/login-flow.ts` and moving session creation behind it.

### 4d. One recommendation to confirm

rdb ended enrolment by writing the name read off the ID onto the signed-in
profile. **I have not carried that over**, and I think it should stay dropped:
your admins are pre-provisioned with a name that is already authoritative, so
overwriting it with OCR text off a scanned card is wrong even though it is the
same person.

The useful operation is the **opposite** — compare the ID name against the
provisioned one and surface a mismatch, since an admin scanning someone else's
ID is exactly what this flow should catch. That needs a backend decision.

`KycSessionContext.updateUser` is therefore in-memory only and writes nothing.
`api.profile.update` still exists in `kycApi.ts` so the old call site compiles;
it is unused.

---

## 5. Current state

- `tsc --noEmit` — **clean**.
- `eslint` — 15 errors, all pre-existing React-hooks issues inherited from rdb
  (`set-state-in-effect`, `immutability`, `purity`), none in the new files.
- Runs on `MockKycService`. **No network calls at all.**
- To go live: `createKycService()` in `services/index.ts` — one line.

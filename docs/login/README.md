# Login — the root sign-in flow

How an administrator gets into the Root console, end to end: what they receive,
what each screen does, and which server call sits behind it.

---

## 1. What the administrator receives

One WhatsApp message, carrying two things:

```
https://<console>/enter/nFTMkeEjZNmhBYp0Ams27q8Js8lFWXKbojzjeDHb-q0
X1D3P12
```

The **access link** and the **private code**, together. There is nothing to
request, no code to wait for, and no resend — which is why the private-code
screen is a heading and a field and nothing else.

The link is issued by another root administrator, or by `cmd/seed`. It is the
only way in: a lost link has no self-service recovery, and only another root
administrator can issue a new one.

---

## 2. The flow

```
/enter/{token}          validate the link server-side, nothing rendered
      │
      ▼
   splash              progress bar fills
      │
      ▼
/login                  PRIVATE_CODE_REQUIRED   — type the code from WhatsApp
      │
      ▼
/login/identity         FACE_REQUIRED           — live face capture
      │
      ├─ first login ──► ID_DOCUMENT_REQUIRED / ID_INFO_REQUIRED
      │                  intro → ID capture → summary → face match → success
      │
      ▼
/login/device           DEVICE_REQUIRED         — passkey  (not built yet)
      │
      ▼
  COMPLETED             tokens issued → /dashboard
```

Any refusal, at any point, lands on **`/no-access`**.

---

## 3. The rule the whole client follows

**Branch on `stage`, never on a step counter.**

Every response from the backend carries the stage it is now at.
`applyStage()` (`src/lib/auth/challenge.ts`) is the single router: each step
handler hands it the response and it decides where the browser goes. No step
names its own successor.

That is not tidiness. A check switched off in a deployment simply never reports
its stage, and this walks past it. A client that hard-coded
"password → OTP → PIN" is exactly what broke when the protocol changed
underneath it.

### Four rules that hold at every step

1. **The challenge token rotates.** Every response carries a new one; the
   previous is dead. Always store the one just returned.
2. **Order is enforced server-side.** A step sent early answers
   `CHALLENGE_INVALID` — and that burns the challenge.
3. **The sequence expires** (10 minutes) and tolerates **5 failed attempts in
   total**. Past either, it is over.
4. **One refusal message.** Unknown link, revoked, expired, wrong country,
   suspended — the backend answers all of them identically, and so do we.

---

## 4. The screens

| Route | Stage | What it does |
| --- | --- | --- |
| `/enter/{token}` | — | Route Handler. Posts the token to `/v1/auth/link`, opens the challenge, redirects. Renders nothing. |
| `/login` | `PRIVATE_CODE_REQUIRED` | The private code, in a text field. No client validation. |
| `/login/identity` | `FACE_REQUIRED` + both ID stages | Face capture and, on a first login, ID enrolment. |
| `/login/device` | `DEVICE_REQUIRED` | Passkey enrolment. **Not built.** |
| `/no-access` | — | Every refusal. |

### Why three stages share `/login/identity`

The face captured at `FACE_REQUIRED` is **reused** when the ID is compared
against it, so the administrator never captures their face twice.

That frame is a ~300 KB data URL living in React state — far too large for a
cookie, and biometric data we will not put in browser storage. It survives
exactly as long as the React tree does. Separate URLs for those stages would
unmount everything and drop it, and the only symptom would be a second capture
nobody asked for.

---

## 5. The face capture

`/login/identity` opens with a black 350×400 frame and yellow corner brackets.
There is no shutter button: capture is automatic once a **local gate** is
satisfied.

`useFaceGate` (`src/features/kyc/hooks/useFaceGate.ts`) samples the video and
requires five things to hold **continuously for 1.2 seconds**:

- exactly one face present
- close enough, but not cropped by the frame
- facing the camera (yaw within ±18°)
- brightness and sharpness in range
- still

**Nothing is uploaded until all five pass.** That is not polish: a dark or
blurred frame comes back as a *failed* check, and the backend counts failures
against a challenge that allows five in total. Sending an unusable frame spends
somebody's attempt on our impatience.

The hold is the whole interaction — brackets pull inward and turn green, a
hairline fills across the frame's foot — so the capture is something the person
watched happen rather than something that happened to them.

The frontend keeps **no attempt counter**. The backend owns that and kills the
session itself; two authorities disagreeing about tries remaining is worse than
one.

---

## 6. Security model

- **The browser never holds a token.** Every credential lives in an httpOnly
  cookie: `root_challenge` mid-sign-in, `root_at` / `root_rt` after.
- **No mock data anywhere.** A mock always says the ID is readable and the faces
  match, so it can prove the screens render but never the thing most likely to
  disappoint. A flow that passes against invented data is indistinguishable from
  one that works.
- **The face image never reaches the auth backend.** It goes to the KYC Worker;
  what reaches `/v1/auth/face` is a verdict. See [KYC integration](../kyc/).
- **`/no-access` reveals nothing** — not even that a sign-in exists here.

---

## 7. Where the code is

| Concern | File |
| --- | --- |
| The wire contract — every path, stage and shape | `src/lib/auth/endpoints.ts` |
| The challenge cookie and `applyStage()` | `src/lib/auth/challenge.ts` |
| Opening a link | `src/lib/auth/link.ts` |
| Step actions | `src/features/auth/actions.ts` |
| Error → message mapping | `src/lib/auth/errors.ts` |
| Face gate | `src/features/kyc/hooks/useFaceGate.ts` |
| Face capture screen | `src/features/kyc/components/screens/FaceScanScreen.tsx` |

---

## 8. Not built yet

- **`/login/device`** — the passkey step. `DEVICE_REQUIRED` currently routes to a
  page that does not exist.
- **The idle lock.** It used to unlock with the 6-digit passcode, which no longer
  exists. Its replacement is a face re-verify, which needs a
  session-authenticated face endpoint the backend does not expose.
- **A verified end-to-end sign-in.** `/v1/auth/link` returns 500 on a real link;
  see [KYC integration §7](../kyc/backend.md).

# KYC verification — ported from rdb

Copied from `frontend/rdb/rdb` (commit `443662e`). rdb keeps its own copy and is
untouched: this is a **copy, not a move**, because `services/kyc` also drives
rdb's face step-up for transfers and passcode reset.

## What came across

| Here | From rdb |
| --- | --- |
| `components/` | `src/components/verification/` |
| `services/` | `src/services/kyc/` |
| `context/VerificationContext.tsx` | same |
| `hooks/` | `useCamera`, `useDocumentScanner`, `useFaceLandmarker`, `useFrameValidation` |
| `config/kycConfig.ts` | same |
| `types/verification.ts` | `src/core/types/verification.ts` |
| `assets/` | `src/assets/icons/verification/` |
| `/scripts/sync-vendor.mjs` | same |

## It does not compile yet — by design

Imports of things that were deliberately **not** copied are commented with
`// TODO(kyc-port):`. Their call sites are still live, so TypeScript will report
them. That is the to-do list; each one is a decision, not a mechanical fix.

### 1. Scaling — DONE (restyled onto the dashboard's scale)

rdb's `src/scaling/` was **not** ported; the screens were restyled onto this
project's XD-pixel utilities instead, so there is only one design system here.
Every XD number is unchanged — only the utility spelling and the unit source
differ (`var(--xd-unit)` there, `--spacing: 0.0625rem` here).

| rdb | here |
| --- | --- |
| `w-xd-390` `h-xd-60` `mb-xd-30` `px-xd-40` `gap-xd-12` | `w-390` `h-60` `mb-30` `px-40` `gap-12` |
| `text-xd-16` | `fz-16` |
| `rounded-xd-20`, `rounded-[20px]` | `rad-20` |
| `left-xd-35` / `right-xd-30` | `start-35` / `end-30` (AGENTS.md §9 — logical, mirrors in RTL) |

**The non-obvious half:** rdb runs Tailwind's *default* `--spacing` (0.25rem),
this project sets it to 0.0625rem. So rdb's plain classes had to be scaled ×4 to
render the same size — `gap-2` (8px there) became `gap-8`, `px-6` became `px-24`,
`mb-4` became `mb-16`. Renaming only the `xd-*` classes would have left every
plain gap a quarter of its designed size.

- `<Page variant="scaled" outerBg>` → the **route** supplies the wrapper (below).
  `VerificationPage` now owns only the step stage.
- `<FlexibleSpace size share>` → `<FlexSpace size share>`
  (`src/components/ui/FlexSpace.tsx`), same call sites, same numbers. rdb read a
  `--xd-flex-deficit` variable set by `AppScaler`; the port expresses the same
  behaviour as plain flexbox — `size` is the flex-basis, `share` the shrink
  factor — so no scaling runtime is needed.
- `xd-fit-screen` → dropped. It fit the canvas to *both* axes; this project's
  root font-size engine scales by width and `globals.css` already pins `body` to
  `position: fixed; inset: 0; overflow: hidden`.

Two things deliberately left as fixed px, matching this project's own stance that
hairlines and strokes don't scale: the 2–3px state-colour borders and the 6–10px
corner-bracket radii on the camera frames (inline `style`, not classNames).

#### The route wrapper (add with the route, once §2 and §3 are wired)

These screens are drawn on the **430 mobile canvas**, and this project picks a
canvas by viewport width (430 / 834 / 1366) — so on a laptop `w-390` is a literal
390px. Render the flow as a centred phone-width column, which is what rdb got
from `<Page variant="scaled">` plus its outer-bg letterbox:

```tsx
// app/(dashboard)/verification/page.tsx
<Screen variant="centered" maxW={430} gutter={0} className="h-full">
  <VerificationPage />
</Screen>
```

`outerBg="intro"` has no equivalent and was dropped — `IntroScreen` already
paints its own `#FFFDD0`; on wide screens the area beside the column is the
dashboard background.

### 2. API — a route-handler proxy, NOT `lib/api/backend.ts`

15 call sites go through rdb's `api` object:

| Call | Where |
| --- | --- |
| `api.kyc.status()` / `startSession()` | `components/VerificationPage.tsx:36,47` |
| `api.kyc.compareFace()` | `components/screens/FaceMatchScreen.tsx:207` |
| `api.kyc.*` (liveness, analyzeId, submit, …) | `services/httpKycService.ts` |
| `api.profile.update()` | `components/screens/SuccessScreen.tsx:62` |

**Correction to the original note here, which said to repoint at
`lib/api/backend.ts`.** `backendFetch` resolves the `root_sys` cookie against the
systems registry and calls *the selected system's* `baseUrl`. KYC is not a
registry system — it is one fixed service (`ramaaz-kyc.…workers.dev`, what rdb
sets as `NEXT_PUBLIC_API_BASE_URL`). Routing it through `backendFetch` would make
the KYC endpoint depend on whichever project happens to be selected on /systems.

`backendFetch` is also `server-only`, and every one of these call sites is in a
Client Component driving a camera. So the shape is:

- `app/api/kyc/[...path]/route.ts` — a same-origin BFF proxy to the Worker,
  forwarding the auth cookie, the way rdb's `app/api/[...path]` does. The browser
  keeps calling `/api/kyc/*`, which satisfies `connect-src 'self'` and keeps the
  token server-side. Server Actions are the wrong tool here — these are
  high-frequency camera-frame posts, not form submits.
- The Worker base URL belongs in `src/lib/env.ts` beside `NEST_API_URL`
  (server-side, a Cloudflare secret) — *not* a `NEXT_PUBLIC_*` var, since with a
  proxy the browser never needs to know it.

Note ESLint's no-`fetch`-in-UI rule covers `src/features/*/components/**`, so it
does not currently catch `services/httpKycService.ts`. The BFF rule still applies.

### 3. Session — `useAuth` has no equivalent here

- `IntroScreen.tsx:15` — greets the signed-in user by name.
- `SuccessScreen.tsx:17,75` — reads `userData.user`, and calls `updateUser()` to
  write the name read off the ID onto the profile.

**Decide who this flow serves before wiring `updateUser`.** In rdb the person
verifying *is* the signed-in user, so writing the ID name to their profile is
correct. If staff here verify *someone else*, that call would overwrite the
operator's own name — it must target the subject instead, or be dropped.

### 4. Dependencies — DONE

`@mediapipe/tasks-vision` was the only genuinely missing package; it is now a
direct dependency.

`framer-motion` was **not** installed. It resolved anyway — the installed
`motion@12` pulls it in transitively, which is why `tsc` never flagged it. That
is luck, not a contract. All five screens now import from `motion/react`, which
is what the rest of this project uses (AGENTS.md §5) and what `motion@12`
actually guarantees.

### 5. Vendor runtimes (~43 MB) — DONE

`public/vendor/` is gitignored and generated by `scripts/sync-vendor.mjs`
(MediaPipe copied from `node_modules`, OpenCV downloaded from docs.opencv.org).
Wired as `postinstall`, so a fresh clone just works; re-run by hand with
`npm run sync:vendor` after bumping `@mediapipe/tasks-vision`.

One fix while wiring it: the script ended in `syncMediapipe() && await syncOpenCv()`,
which skipped the OpenCV download whenever MediaPipe was missing — exactly the
fresh-clone case it exists to serve. Both now run unconditionally.

### 6. CSP — do this last, and scope it

OpenCV loads its WASM from a `data:` URI, and both runtimes must be served from
our own origin. rdb needs `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`
and `connect-src` including `data:`. Without this, ID capture hangs on
"Card detected — scanning…" forever with no error — it cost real debugging time
in rdb, so set it before testing.

**But don't copy rdb's policy wholesale.** `src/middleware.ts` builds ONE global
CSP for the whole dashboard, and production currently has no `unsafe-eval` at all
(it's dev-only). Granting rdb's directives globally weakens every route — login,
systems, regions — for a feature only `/verification` uses. Two things to hold to:

- `wasm-unsafe-eval` instead of `unsafe-eval`. It is exactly what OpenCV and
  MediaPipe need (WASM compilation) and nothing more; general `eval()` stays
  blocked.
- Widen only on the KYC path. `buildCsp()` already takes the request — branch on
  the pathname so the extra `blob:` / `data:` grants apply to `/verification`
  and `/api/kyc/*` and nowhere else.

This project also uses a strict `'nonce-…' 'strict-dynamic'` script policy, which
rdb does not — check the vendor runtimes load under it before assuming rdb's
`'unsafe-inline'` is what's missing.

## Not copied on purpose

`app/verification/page.tsx` — the route. Add one once the seams above are wired,
so nothing imports this feature until it works.

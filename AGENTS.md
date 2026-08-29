<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may
all differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation
notices.

<!-- END:nextjs-agent-rules -->

# RDB Management — Conventions (the only way)

This project deliberately has **one way** to do each thing. Don't introduce a
second pattern; extend the existing one. These conventions are also meant to be
extracted into a reusable Claude Code skill.

Stack: **Next.js 16 (App Router) · React 19 · Tailwind v4 · TypeScript · Motion
· OpenNext on Cloudflare**. Backend is **NestJS** (separate repo).

## 1. Responsive scaling — XD pixels that scale

The root `font-size` is driven by the viewport (`src/app/globals.css`), so every
`rem`-based value scales together → identical shape at every size ("the
sample").

`--spacing` is `0.0625rem`, so **1 Tailwind unit = 1 XD pixel**:

| XD says    | You write    |
| ---------- | ------------ |
| 300 × 60   | `w-300 h-60` |
| padding 24 | `p-24`       |
| gap 16     | `gap-16`     |
| font 18    | `fz-18`      |
| radius 12  | `rad-12`     |

- **Never** write raw px in a className (`w-[300px]`) — it won't scale and lint
  bans it.
- Three canvases (reference widths): **laptop 1366 / tablet 834 / mobile 430**.
  Each scales 1:1 inside its band, caps at the reference (side whitespace
  above), mobile **locks at 400px** (scrolls below).
- Every page renders inside exactly one `<Screen variant="centered" | "bleed">`.
  `centered` (forms/text) gets a max-width column; `bleed` (dashboards) is full.

**Project-wide design tokens (XD):**

- Font: **Quicksand** (`--font-app-sans`, loaded in `layout.tsx`; Arabic falls
  back to system sans). Use `fz-*` for size; `font-normal/medium/semibold/bold`.
- Colors: `bg-primary`/`text-primary` = `#3066CC` (action blue); `border-line` =
  `#707070` (hairline); `text-foreground` `#171717`; `text-black` `#000`.
- Borders: **every border is 0.5px** (set globally in `globals.css`; hairlines
  intentionally don't scale). Just use `border` / `border-b` etc.
- Non-square brand/illustration assets: `<Icon name="…" width={W} height={H} />`
  (XD px). Square glyphs still use `size`.

## 2. Talking to the API — BFF only

- The browser **never** calls NestJS and **never** holds a token.
- Server-only `src/lib/api/server.ts` (`api.get/post/...`) is the single client
  for the **root backend** (auth, the systems registry). Its base URL is
  `NEST_API_URL`; the local `root-backend` service was deleted and the remote
  replacement isn't wired yet, so that var is unset and calls fail with one
  clear `BackendNotConfiguredError` rather than crashing a render.
- **Auth paths live in one table** — `src/lib/auth/endpoints.ts` (`AUTH_PATHS`),
  used by `features/auth/actions.ts`, `lib/auth/session.ts` and `middleware.ts`.
  Never hardcode an `/auth/*` path at a call site; add it there. The current
  entries are the deleted backend's and are UNVERIFIED against the remote one.
- **Project data** (regions, currencies, languages, …) lives in the SELECTED
  system's own backend: `src/lib/api/backend.ts` (`backendFetch.get/post/...`)
  resolves the `rdb_sys` cookie against the registry and routes to that
  system's `baseUrl`. Selecting happens on /systems (`selectSystem` action).
- Mutations from the browser → **Server Actions** (`features/*/actions.ts`).
- Data for Server Components → a feature **api module** (`features/*/api.ts`).
- UI components calling `fetch` directly is a lint error.

## 3. Auth & roles

- **The login protocol** (MFA Type Root — secret permalink, WhatsApp code, face
  + ID, dual approval) is specified in **`docs/auth-protocol.md`** (Arabic:
  `docs/auth-protocol.ar.md`; keep the two in sync). Those files describe the
  *protocol*; `src/lib/auth/endpoints.ts` describes the *wire contract*. Much of
  the protocol is still unbuilt — the doc marks what exists, flags where the
  implemented flow diverges, and lists the open questions blocking the rest.
- httpOnly cookies (`rdb_at`/`rdb_rt`), set only in
  actions/route-handlers/middleware.
- `src/middleware.ts` (edge middleware) does silent refresh + security headers
  (CSP/HSTS). **It must be `middleware.ts`, not `proxy.ts`:** in Next 16 the
  `proxy` convention is locked to the Node.js runtime, and OpenNext/Cloudflare
  only supports an **edge** middleware. The build prints a `proxy`-deprecation
  warning — that's expected; ignore it.
- The authoritative gate is `requireSession()` / `requireRole()` in protected
  layouts/pages — they call NestJS `/auth/me`. **Frontend RBAC is for rendering
  only; NestJS enforces every real rule.**
- Registration is identical for all roles; the backend assigns the role.

## 4. Validation

- One zod schema per concern in `features/*/schema.ts`, shared by client +
  server.
- API responses are parsed with the schema in `api.ts` so backend drift fails
  loud.

## 5. Icons & animation

- Icons: `<Icon name="user" />` only. XD `.svg` files live in `/public/icons`.
  **No inline `<svg>` in pages.** `mask` mode recolors monochrome glyphs.
- Animation: import presets from `src/components/motion/presets.ts`. Page
  transitions via `template.tsx`; cards via `<AnimatedCard>`. Honor
  reduced-motion.

## 6. Folder layering (lint-enforced)

```
app        → features, components, lib   (routes only; thin)
features   → components, lib             (vertical slices: schema/api/actions/components)
components → lib                         (ui primitives + motion)
lib        → lib                         (api client, auth, env, utils)
```

Start a new feature with `npm run gen` — never hand-roll the structure.

## 7. Commands

| Command              | What                                                       |
| -------------------- | ---------------------------------------------------------- |
| `npm run dev`        | `next dev` (Turbopack) on **port 3002**                     |
| `npm run dev:mobile` | Same, over **https on the LAN** — for testing on a phone    |
| `npm run lint`       | ESLint (layering + fetch ban)                               |
| `npm run typecheck`  | `tsc --noEmit`                                              |
| `npm run gen`        | Scaffold a new feature slice                                |
| `npm run build`      | `next build --webpack` — produces `.next` only, NOT a Worker |
| `npm run preview`    | OpenNext build + run on Cloudflare Workers locally           |
| `npm run deploy`     | OpenNext build + deploy to Cloudflare                        |

`dev:mobile` exists because iOS needs https for `getUserMedia` — the KYC screens
cannot open a camera over plain http on a LAN address. It serves a self-signed
certificate, so the phone will warn once.

⚠️ `npm run build` is **not** a deployable build. It runs Next only; the Worker
(`.open-next/worker.js`) comes from `opennextjs-cloudflare build`. See §8 — this
distinction has already cost one broken deploy configuration.

## 8. Branches & deploy

### Branch model

`main` is the release branch. `dev` is where work happens, and it is the repo's
default branch. A feature goes from zero to finished on `dev` — built, exercised
end to end, its scenarios closed — and only then merges to `main`. Nothing
half-built lands on `main`.

⚠️ **This is the intent, not yet the wiring.** Cloudflare's production branch is
currently **`dev`**, so every push to `dev` deploys to the live worker. That is
deliberate and temporary: a second worker for `main`, configured identically, is
planned. Until it exists, treat a push to `dev` as a production release.

### Cloudflare Workers Builds

Connected to `Yazan-Rammaz/ramaaz-root`, worker **`canroot`**, production branch
**`dev`**, preview builds on. Settings that matter:

| Field | Value |
| --- | --- |
| Build command | `npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `NODE_VERSION = 22` |

- **The build command is not `npm run build`.** That runs Next alone and
  produces `.next`; `wrangler.jsonc` points `main` at `.open-next/worker.js` and
  assets at `.open-next/assets`, and `.open-next/` is git-ignored — so a fresh
  clone that only ran `npm run build` has no Worker to deploy at all. This was
  the original misconfiguration; it fails at the deploy step, not the build one,
  which makes it read like a Cloudflare problem rather than a command problem.
- **First builds are slow.** `postinstall` runs `scripts/sync-vendor.mjs`, which
  downloads ~43MB of opencv.js and MediaPipe wasm into `public/vendor`. It is not
  optional — the KYC screens import those runtimes.
- Measured on 2026-08-29: `opennextjs-cloudflare build` exits 0 and
  `wrangler deploy --dry-run` reports **6.86MB raw / 1.42MB gzipped**, against a
  3MB gzipped limit on the free plan. Room to spare, but it is the number to
  re-check before adding anything large.
- **The production build uses webpack, not Turbopack** (`build` =
  `next build --webpack`). OpenNext/Cloudflare can't load Turbopack's split
  server chunks at runtime (`ChunkLoadError` → 500 on every route). Local
  `next dev` still uses Turbopack. Don't drop the `--webpack` flag.
- The worker is named **`canroot`** (`wrangler.jsonc`); URL
  `https://canroot.yazan-adnof.workers.dev`. `NEST_API_URL` is a `vars`
  entry, not a secret — it is a public hostname, and a `vars` entry would in
  any case shadow a secret of the same name.
  - That hostname is load-bearing beyond deployment: it is in the KYC Worker's
    `TENANTS` origin list for the `root` tenant (CORS), and it is the only
    domain this console can currently host a **passkey** on. WebAuthn requires
    the RP ID to be a real domain, so neither a LAN IP nor a tunnel with a
    changing subdomain will do — the device step can only be exercised here or
    on `localhost`.

### CI

`.github/workflows/ci.yml` runs on push to `main` and `dev`, and on every PR:
**lint → typecheck → build**. No test steps — see §10.

`NEST_API_URL` is deliberately unset in CI. The BFF client validates it lazily
and throws `BackendNotConfiguredError`, which the auth code already treats as
"signed out", so the build completes and prerenders every route. A build with
the variable unset produces the same route table as one with it set; the fake
host that used to be there only bought DNS timeouts during prerender.

## 9. Internationalization (i18n) & text direction

Three languages, **one way**: `next-intl` with a **cookie-based** locale (no
`/en` URL prefix). Supported locales live in **one place**:
`src/lib/i18n/config.ts`.

- **Languages:** `en` (default), `ar`, `tr`. To add one: add the code to
  `locales` in `config.ts` **and** add `messages/<code>.json`. Nothing else.
- **Direction is automatic.** `localeDirection()` in `config.ts` is the ONLY
  place LTR/RTL is decided (`ar` → rtl). It is applied **once** on `<html dir>`
  in `src/app/layout.tsx`. **Never** set `dir` on individual elements or branch
  on language in a component.
- **Author direction-agnostic UI.** Use **logical** Tailwind utilities so
  layouts mirror themselves:
    - spacing/position: `ps-`/`pe-`, `ms-`/`me-`, `start-`/`end-` — never
      `pl/pr`, `ml/mr`, `left/right`.
    - alignment: `text-start`/`text-end` (not `text-left/right`); for flex rows,
      `justify-start`/`justify-end` already follow `dir`.
    - prefer `gap-*` over directional margins between siblings.
    - (`px-*`/`mx-*` are symmetric, so they're fine.)
- **No hardcoded UI strings.** Every user-facing string is a key in
  `messages/*.json`. `en.json` is the canonical key set (type-checked via
  `global.d.ts`); keep `ar.json`/`tr.json` structurally identical.
    - Server Components / layouts: `const t = await getTranslations("ns")`.
    - Client Components: `const t = useTranslations("ns")`.
    - Interpolation/plurals use ICU: `t("dashboard.welcome", { name })`.
- **Switching language:** `<LocaleSwitcher>` (`components/ui`) → `setLocale()`
  Server Action (`src/lib/i18n/locale.ts`) sets the `rdb_lang` cookie, then
  `router.refresh()`. The page re-renders with new messages and `<html dir>`
  flips. First-visit language is auto-detected from `Accept-Language` in
  `src/middleware.ts`, then remembered in the cookie.
    - **The switcher lives ONLY on the Settings page** — never in headers,
      layouts, or other screens.

## 10. Session pickup — where we left off (as of 2026-08-29)

`tsc`, `eslint` and `next build` all pass, and so does
`opennextjs-cloudflare build`.

**This project has no automated tests** — no unit, component or e2e suite.
Verify changes by running the app. CI reflects this: it runs lint, typecheck and
build, nothing else.

> ⚠️ **Open question.** The branch model in §8 says a feature merges to `main`
> "with tests and closed scenarios". If that means *automated* tests, this
> paragraph and `.github/workflows/ci.yml` both have to change — the scripts and
> the tooling are gone (`vitest.config.ts` and the suites were deleted, and the
> workflow referenced `npm run test` / `npm run e2e` for months after neither
> existed, which is why CI was permanently red). Decide which it is before the
> next feature lands.

**Repo:** `https://github.com/Yazan-Rammaz/ramaaz-root`. Both `dev` and `main`
are pushed and currently identical. `dev` is the default branch.

**Lint debt, deliberately scoped.** `eslint.config.mjs` downgrades three React
Compiler rules (`set-state-in-effect`, `immutability`, `purity`) to warnings for
`src/features/kyc/**` only. Those 15 findings are real — camera loops and
scanner state machines ported from rdb — but fixing them means restructuring
live camera code CI cannot exercise. They stay errors everywhere else so the
debt cannot spread. `public/vendor/**` is ignored outright: it is downloaded,
git-ignored, third-party, and not ours to lint.

**i18n is wired** (see §9): `next-intl`, cookie-based `en`/`ar`/`tr`, auto
direction. New screens must follow §9 — no hardcoded strings, logical Tailwind
utilities only. ⚠️ Most **KYC screens still carry hardcoded English**; only the
newer ones (face scan, private code, device, no-access, intro) use `messages/`.
The `ar`/`tr` copy for the intro consent paragraph is an unreviewed draft.

**Design gallery.** `/design` renders every screen standalone at its exact XD
canvas, with an Alt-to-measure inspector and drawn iPhone/Safari/Chrome chrome;
`/design/metrics` reads a real device's viewport. Add a screen by editing
`src/app/design/catalog.ts` and `screens.tsx` together.

Always on in development. In a deployed environment it is **off unless
`DESIGN_GALLERY_KEY` is set** — as a Cloudflare *secret*, never a `wrangler.jsonc`
`vars` entry, which would shadow the secret and commit the value. With it set,
unlock a device once at `/design/unlock?key=…`; that swaps the key for a
`/design`-scoped httpOnly cookie. Everything without the cookie answers `404`,
including `/design/unlock` itself with a wrong key — a `401` would confirm there
is something there to unlock.

It is gated because it renders every screen of this console with the session
gate and the sign-in challenge stepped over. No real data and no session, so it
grants access to nothing — but it does hand a stranger the exact shape and
wording of the whole sign-in, which is material for walking somebody through a
convincing fake of it.

Open items, in priority order:

1. **Confirm/align the NestJS auth contract.** The BFF currently assumes:
    - `POST /auth/login`, `POST /auth/register`, `POST /auth/refresh` → respond
      `{ accessToken, refreshToken, accessMaxAge, refreshMaxAge }`
    - `GET /auth/me` → `{ id, email, name, role, countryCode? }`
    - `POST /auth/logout` If the real NestJS endpoints differ, update
      `src/lib/api/server.ts`, `src/features/auth/actions.ts`,
      `src/lib/auth/session.ts`, and `src/middleware.ts` to match.

2. **Build real screens from XD.** Translate frames using the XD-pixel utilities
   (section 1). Each new domain area = `npm run gen` then wire pages under
   `src/app/(dashboard)/`. Drop exported `.svg` icons into `/public/icons`.

3. **Give `main` its own worker.** Cloudflare's production branch is `dev`
   today, so `main` deploys nowhere and every push to `dev` is a release. A
   second worker for `main` with the same config closes that gap — see §8.

Roles so far: `super_admin`, `country_manager`, `agent`
(`src/lib/auth/rbac.ts`). Extend there if more are needed.

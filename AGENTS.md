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

| Command             | What                                         |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Local dev (Cloudflare bindings via OpenNext) |
| `npm run lint`      | ESLint (layering + fetch ban)                |
| `npm run typecheck` | `tsc --noEmit`                               |
| `npm run gen`       | Scaffold a new feature slice                 |
| `npm run preview`   | Build + run on Cloudflare Workers locally    |
| `npm run deploy`    | Build + deploy to Cloudflare                 |

## 8. Deploy

Cloudflare **Workers Builds** is connected to the git repo → push to `main`
auto-builds (`opennextjs-cloudflare build`) and deploys. Secrets
(`NEST_API_URL`) are Cloudflare secrets; local dev uses `.dev.vars`
(git-ignored).

- **The production build uses webpack, not Turbopack** (`build` =
  `next build --webpack`). OpenNext/Cloudflare can't load Turbopack's split
  server chunks at runtime (`ChunkLoadError` → 500 on every route). Local
  `next dev` still uses Turbopack. Don't drop the `--webpack` flag.
- The worker is named **`management`** (`wrangler.jsonc`); URL
  `https://management.yazan-adnof.workers.dev`. Set the real backend with
  `wrangler secret put NEST_API_URL` — don't ship the placeholder `vars` value.

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

## 10. Session pickup — where we left off (as of 2026-06-17)

The scaffold is complete and verified: `tsc`, `eslint` and `next build` all
pass. **This project has no automated tests** — no unit, component or e2e
suite, and none should be added. Verify changes by running the app.
Initial commit is on `main`. Remote `origin` is set to
`https://github.com/Yazan-Rammaz/management.git` but **nothing is pushed yet**
(by the owner's request).

**i18n is wired** (see §9): `next-intl`, cookie-based `en`/`ar`/`tr`, auto
direction, dev port is `3006`. All existing screens are translated. New screens
must follow §9 — no hardcoded strings, logical Tailwind utilities only.

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

3. **Deploy wiring (owner action):** `git push -u origin main`, then connect the
   repo in Cloudflare → Workers Builds and set the `NEST_API_URL` secret.

Roles so far: `super_admin`, `country_manager`, `agent`
(`src/lib/auth/rbac.ts`). Extend there if more are needed.

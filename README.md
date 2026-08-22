# RDB Management

Admin frontend for the agent bank & per-country managers. Next.js (App Router)
on Cloudflare via OpenNext, integrating with a NestJS backend.

> Read **[AGENTS.md](./AGENTS.md)** first — it defines the single, enforced way
> to do everything (scaling, API access, auth, features). This README is just
> setup.

## Quick start

```bash
cp .dev.vars.example .dev.vars   # set NEST_API_URL to your local NestJS
npm install
npm run dev                      # http://localhost:3000
```

## What's in here

- **Scaling system** — design in XD pixels (`w-300 h-60`, `fz-18`, `rad-12`);
  everything scales 1:1 across laptop (1366) / tablet (834) / mobile (430),
  locking at 400px. See `src/app/globals.css`.
- **BFF security** — browser never holds a token or calls NestJS directly;
  httpOnly cookies, server-only API client, strict CSP/HSTS in `middleware.ts`.
- **Roles** — same registration for all; NestJS owns authorization.
- **iOS animations** — Motion presets, page transitions, shared-element cards.
- **One way enforced** — import-layer + no-`fetch`-in-UI lint, feature generator.

## Scripts

| Command             | What it does                                 |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Local dev with Cloudflare bindings           |
| `npm run lint`      | ESLint (layering + fetch ban)                |
| `npm run typecheck` | `tsc --noEmit`                               |
| `npm run gen`       | Scaffold a new feature slice                 |
| `npm run preview`   | Build + run on Cloudflare Workers locally    |
| `npm run deploy`    | Build + deploy to Cloudflare                 |
| `npm run cf-typegen`| Generate Cloudflare env types                |

## Deploy (auto on push)

Connect this repo to **Cloudflare → Workers & Pages → Workers Builds**. Each push
to `main` runs `opennextjs-cloudflare build` and deploys. Set `NEST_API_URL` (and
any other secrets) in the Cloudflare dashboard or via `wrangler secret put`.

import "server-only";
import { z } from "zod";

/**
 * Server-only, validated environment. Importing this in a Client Component is a
 * build error (via "server-only"), which keeps secrets off the browser.
 *
 * On Cloudflare these come from Worker/Pages bindings & secrets — never commit
 * real values. See .dev.vars (git-ignored) for local development.
 *
 * Validation is LAZY and runtime-only. During `next build` the Worker
 * secrets/vars don't exist yet, and the eager top-level parse used to abort the
 * build. We still want to "fail loud" on bad config — but at runtime, on first
 * actual access, not while compiling. So we validate the first time a field is
 * read and only throw when not in the build phase.
 */
const schema = z.object({
  /**
   * Base URL of the backend the BFF proxies to (server-side only).
   *
   * OPTIONAL, deliberately: the local `root-backend` has been deleted and the
   * remote backend's URL is not known yet. Unset means "no backend wired" —
   * `lib/api/server.ts` turns that into one clear `BackendNotConfiguredError`
   * instead of a crash, so every screen still renders for review. Set it and
   * the whole BFF works again with no other change.
   */
  NEST_API_URL: z
    .string()
    .url()
    // `.url()` alone is not enough on its own: Zod 4 accepts "localhost:9999"
    // and "ftp://host" as valid URLs, and both produce broken fetches. A base
    // URL we can concatenate a path onto must be http(s).
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "must start with http:// or https://",
    })
    // Paths all begin with "/", so a trailing slash yields "host//auth/me".
    .transform((u) => u.replace(/\/+$/, ""))
    .optional(),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

type Env = z.infer<typeof schema>;

// Next sets this during `next build` (incl. OpenNext's internal next build).
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

let cached: Env | null = null;
function load(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse({
    NEST_API_URL: process.env.NEST_API_URL,
    NODE_ENV: process.env.NODE_ENV,
  });

  if (parsed.success) {
    cached = parsed.data;
  } else if (isBuildPhase) {
    // Don't break the build over env that only exists at runtime. Leaving the
    // URL unset is the honest value here — a request-time read re-validates.
    cached = {
      NEST_API_URL: undefined,
      NODE_ENV: "production",
    };
  } else {
    throw new Error(
      `Invalid server environment:\n${z.prettifyError(parsed.error)}`,
    );
  }

  return cached;
}

/** Validated env, resolved lazily on first property access. */
export const env = new Proxy({} as Env, {
  get: (_target, prop: string) => load()[prop as keyof Env],
});

// Read straight from process.env so importing this module never triggers
// validation; NODE_ENV always has a sane value during build and at runtime.
export const isProd = process.env.NODE_ENV === "production";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Layering ("only one way") is enforced with import zones — no resolver needed,
 * fully deterministic:
 *
 *   lib  ->  (lib only)
 *   components -> lib, components
 *   features   -> lib, components, features
 *   app        -> anything
 *
 * Plus: UI components may not call `fetch` directly — data goes through a
 * Server Action or a feature `api` module. Tokens stay server-side; the browser
 * only talks to our own origin (also enforced at runtime by CSP + server-only).
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  {
    files: ["plopfile.mjs", "*.config.{js,mjs,ts}"],
    rules: { "import/no-anonymous-default-export": "off" },
  },

  {
    files: ["src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/features/**"], message: "lib must not import from features." },
            { group: ["@/components/**"], message: "lib must not import from components." },
            { group: ["@/app/**"], message: "lib must not import from app." },
          ],
        },
      ],
    },
  },

  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/features/**"], message: "components must not import from features." },
            { group: ["@/app/**"], message: "components must not import from app." },
          ],
        },
      ],
    },
  },

  {
    files: ["src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/app/**"], message: "features must not import from app." },
          ],
        },
      ],
    },
  },

  {
    // UI components: no direct network calls.
    files: ["src/components/**/*.{ts,tsx}", "src/features/**/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Don't call fetch in UI. Use a Server Action or a feature `api` module (src/features/*/api.ts).",
        },
      ],
    },
  },

  {
    /**
     * The ported KYC feature, and its inherited lint debt.
     *
     * These four rules are React Compiler checks, and every violation of them
     * in this repo is inside `features/kyc` — camera loops and scanner state
     * machines that came over from rdb already written this way. They are real
     * findings, not noise: `set-state-in-effect` cascades renders, `purity`
     * flags a side effect during render. They are downgraded rather than fixed
     * because fixing them means restructuring live camera code that cannot be
     * exercised in CI (no camera), and a silent regression there costs a user
     * their sign-in.
     *
     * Scoped to this directory ON PURPOSE. Everywhere else — including new
     * code — these stay errors, so the debt cannot spread. Delete this block
     * once the KYC screens have been reworked; `npm run lint` will then say
     * exactly what is left.
     */
    files: ["src/features/kyc/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
    },
  },

  {
    // The diagnostics collector — the ONE place a `fetch` in the UI layer is
    // correct, and the exception belongs here rather than in the file.
    //
    // The ban exists so application data goes through the BFF and never
    // straight from the browser. This is not application data: it is the
    // collector's own transport to a separate logging service, the same one
    // every other project posts to, and routing it through this app's server
    // would defeat the point of a service any front end can report to. The
    // origin is named in `connect-src`; what crosses is metadata and scrubbed
    // bodies, never the KYC routes (see denyBodyPaths).
    //
    // Configured rather than an inline eslint-disable because the top of that
    // file is GENERATED — `npm run sync:root` in ramaaz-observe rewrites it,
    // and a comment there is silently wiped on the next sync. It was, once.
    files: ["src/components/Observe.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    ".open-next/**",
    ".wrangler/**",
    ".history/**",
    "next-env.d.ts",
    // Browser runtimes fetched by `scripts/sync-vendor.mjs` on postinstall —
    // opencv.js and MediaPipe's wasm glue, ~43MB of minified third-party code.
    // They are git-ignored, so they are not ours to lint or to fix; before this
    // they contributed 22 of the 37 errors and made `npm run lint` fail on a
    // clean checkout the moment postinstall had run.
    "public/vendor/**",
  ]),
]);

export default eslintConfig;

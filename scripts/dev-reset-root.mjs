#!/usr/bin/env node
/**
 * Mint a fresh root admin on staging and write its invitation token into
 * .env.local.
 *
 * ⚠️ DESTRUCTIVE, AND DELIBERATELY NOT PART OF THE APP.
 * POST /v1/dev/reset-root DELETES the existing root admin (its response has a
 * `deleted_user_id`) and creates a replacement with new credentials. It exists
 * to bootstrap a test account, nothing more. It must never be reachable from
 * the login flow: calling it there would delete the administrator every time
 * somebody tried to sign in.
 *
 * Usage:  npm run dev:reset
 * Needs:  DEV_RESET_KEY and NEST_API_URL in .env.local
 *
 * The printed private code + password + token are what the registration flow
 * consumes: /v1/registration → /v1/registration/otp → /v1/registration/pass-code.
 * The invitation token is SINGLE USE — one registration attempt spends it, and
 * a fresh one needs another reset.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(ROOT, ".env.local");

function readEnv() {
  const out = {};
  let raw = "";
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch {
    return { vars: out, raw: "" };
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { vars: out, raw };
}

const { vars, raw } = readEnv();
const base = vars.NEST_API_URL;
const key = vars.DEV_RESET_KEY;

if (!base) {
  console.error("NEST_API_URL is not set in .env.local");
  process.exit(1);
}
if (!key) {
  console.error("DEV_RESET_KEY is not set in .env.local");
  process.exit(1);
}

const res = await fetch(`${base}/v1/dev/reset-root`, {
  method: "POST",
  headers: {
    "X-Dev-Reset-Key": key,
    Accept: "application/json",
    "User-Agent": "RamaazRootDashboard/1.0",
  },
});

const body = await res.json().catch(() => null);

if (!res.ok) {
  console.error(`reset-root failed (${res.status}):`, body?.error?.message ?? body);
  process.exit(1);
}

console.log("Root admin reset.\n");
console.log(`  deleted user   ${body.deleted_user_id}`);
console.log(`  new user       ${body.user_id}`);
console.log(`  phone          ${body.phone}`);
console.log(`  private code   ${body.private_code}`);
console.log(`  password       ${body.password}`);
console.log(`  token expires  ${body.expires_at}\n`);

// Persist just the token — it is the only value the app itself reads.
const line = `REGISTRATION_TOKEN=${body.invitation_token}`;
const next = /^REGISTRATION_TOKEN=.*$/m.test(raw)
  ? raw.replace(/^REGISTRATION_TOKEN=.*$/m, line)
  : `${raw.replace(/\s*$/, "")}\n${line}\n`;
writeFileSync(ENV_FILE, next);

console.log("REGISTRATION_TOKEN written to .env.local.");
console.log("Sign in with the private code and password above; the WhatsApp");
console.log(`code goes to ${body.phone}.`);

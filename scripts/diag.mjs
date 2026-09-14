#!/usr/bin/env node
/**
 * Read a browser diagnostic record back out of KV.
 *
 *   node scripts/diag.mjs list                  every sign-in with a record
 *   node scripts/diag.mjs list <challengeId>    the flushes for one sign-in
 *   node scripts/diag.mjs show <challengeId>    the whole record, in order
 *
 * The challenge id is the join: it is what the backend quotes in its own log
 * lines, so a report like "01M2GKPBFGNRNY1CNN1PHXYCJS failed" is enough to pull
 * the browser side of the same attempt.
 *
 * Wraps `wrangler kv`, so it authenticates the same way everything else here
 * does — no second credential to hold, and it works with the OAuth token
 * `wrangler login` already wrote.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ACCOUNT_ID = "725421c06cddc0ed4694b7cd177ae60e";
const BINDING = "DIAG";

function wrangler(args) {
    // Wrangler's own entry point, run by this Node — not `npx`, and not a
    // shell. `shell: true` concatenates arguments instead of escaping them
    // (Node DEP0190), and one of these arguments is a challenge id pasted out
    // of a log: not a string to hand to a command line unquoted. Resolving the
    // script directly also skips npx's resolution step, which on Windows needs
    // a shell to find `npx.cmd` at all.
    const bin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    return execFileSync(process.execPath, [bin, ...args], {
        encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
        maxBuffer: 64 * 1024 * 1024,
    });
}

/** `wrangler kv key list` prints a JSON array, sometimes behind a banner. */
function listKeys(prefix) {
    const out = wrangler([
        "kv",
        "key",
        "list",
        `--binding=${BINDING}`,
        "--remote",
        ...(prefix ? [`--prefix=${prefix}`] : []),
    ]);
    const start = out.indexOf("[");
    if (start === -1) return [];
    return JSON.parse(out.slice(start)).map((k) => k.name);
}

function getKey(key) {
    return wrangler(["kv", "key", "get", key, `--binding=${BINDING}`, "--remote"]);
}

const [command, argument] = process.argv.slice(2);

if (command === "list" && !argument) {
    // Collapse `diag:<challenge>:<sid>:<seq>` down to the distinct sign-ins.
    const sessions = new Map();
    for (const key of listKeys("diag:")) {
        const challenge = key.split(":")[1];
        sessions.set(challenge, (sessions.get(challenge) ?? 0) + 1);
    }
    if (sessions.size === 0) {
        console.log("No diagnostic records. Nothing has failed, or nothing has run yet.");
    }
    for (const [challenge, count] of sessions) {
        console.log(`${challenge}\t${count} flush(es)`);
    }
} else if (command === "list") {
    for (const key of listKeys(`diag:${argument}:`)) console.log(key);
} else if (command === "show" && argument) {
    const keys = listKeys(`diag:${argument}:`).sort();
    if (keys.length === 0) {
        console.log(`No record for ${argument}.`);
        console.log("It may have aged out — records live 30 days.");
        process.exit(1);
    }
    for (const key of keys) {
        const bundle = JSON.parse(getKey(key));
        console.log(`\n── ${key}  (${bundle.storedAt})`);
        console.log(`   ${bundle.ua ?? "unknown UA"}  ${bundle.screen ?? ""}`);
        for (const e of bundle.events) {
            const when = new Date(e.t).toISOString().slice(11, 23);
            const detail =
                e.kind === "fetch"
                    ? `${e.method} ${e.path} → ${e.status} (${e.ms}ms)${e.msg ? ` ${e.msg}` : ""}`
                    : `${e.name ? `[${e.name}] ` : ""}${e.msg ?? ""}`;
            console.log(`   ${when}  ${(e.level ?? e.kind).padEnd(5)}  ${detail}`);
        }
    }
} else {
    console.log("usage: node scripts/diag.mjs list [challengeId] | show <challengeId>");
    process.exit(1);
}

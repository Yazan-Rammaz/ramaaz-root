#!/usr/bin/env node
/**
 * The PRODUCTION build, on a phone — over HTTPS on the LAN (2026-11-24).
 *
 * `npm run dev:mobile` is the dev server, and some things only happen in a
 * production build: <Link> prefetching (hover / touch preloading, IntentLink) and
 * the 30-second page cache (`staleTimes`) among them. This serves `next start`
 * to the phone the same way dev:mobile serves `next dev`.
 *
 * HTTPS is not optional: in production the session cookies are `Secure`, and a
 * phone throws a Secure cookie away over plain http — every sign-in would bounce.
 * `next start` has no https of its own, so this runs it on 127.0.0.1 and puts a
 * small https proxy in front, with the certificate dev:mobile already minted for
 * this machine's address (`certificates/`). Host and Origin pass through
 * untouched, so Server Actions see the address the phone typed.
 *
 * Run with:  npm run build   (once, after each change)
 *            npm run start:mobile
 */
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

function lanAddress() {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family !== 'IPv4' || address.internal) continue;
            if (address.address.startsWith('169.254.')) continue;
            return address.address;
        }
    }
    return null;
}

const host = process.argv[2] || lanAddress();
const port = Number(process.env.PORT ?? 3443);
const inner = 3013;

const dir = new URL('../certificates/', import.meta.url);
const certFile = fileURLToPath(new URL('localhost.pem', dir));
const keyFile = fileURLToPath(new URL('localhost-key.pem', dir));
if (!existsSync(certFile) || !existsSync(keyFile)) {
    console.error('\n  No certificate yet. Run `npm run dev:mobile` once (it makes one), stop it, then run this again.\n');
    process.exit(1);
}
if (!existsSync(new URL('../.next/BUILD_ID', import.meta.url))) {
    console.error('\n  No production build. Run `npm run build` first.\n');
    process.exit(1);
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const next = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(inner)], {
    stdio: 'inherit',
    env: { ...process.env },
});
next.on('exit', (code) => process.exit(code ?? 0));

const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    const upstream = http.request(
        {
            host: '127.0.0.1',
            port: inner,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' },
        },
        (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
        },
    );
    upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('The app is still starting — reload in a moment.');
    });
    req.pipe(upstream);
});
server.listen(port, '0.0.0.0', () => {
    console.log(`\n  Production build, open on the phone:  https://${host}:${port}`);
    console.log('  Same Wi-Fi, and accept the certificate warning once.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close();
        next.kill(signal);
    });
}

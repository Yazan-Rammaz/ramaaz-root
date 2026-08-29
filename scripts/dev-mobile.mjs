#!/usr/bin/env node
/**
 * Dev server a phone can actually use — over HTTPS.
 *
 * ── Why HTTPS is not optional here ──────────────────────────────────────────
 * The identity flow drives a camera, and `getUserMedia` exists only in a
 * SECURE CONTEXT: https, or localhost. A phone on the LAN is neither, so over
 * plain http the camera is not blocked so much as absent — the API is simply
 * not on `navigator.mediaDevices`, and the face screen sits on a black frame
 * forever with nothing to say why. No amount of `allowedDevOrigins` or CSP
 * changes that: the browser decides before our code runs.
 *
 * `next dev --experimental-https` generates a locally-trusted certificate with
 * mkcert (downloaded on first use), which is what makes the origin secure.
 *
 * ── Why this script exists rather than a flag in package.json ───────────────
 * The certificate must name the address the PHONE types. Next builds it from
 * `-H`: `createSelfSignedCertificate(host)` always includes localhost,
 * 127.0.0.1 and ::1, plus the host when it differs. Hardcoding the LAN IP in
 * package.json would therefore mint a certificate that stops matching the
 * moment DHCP hands out a different address — and the failure would appear on
 * the phone as a certificate error, a long way from the cause.
 *
 * So the address is resolved here, at run time, and passed through. Next
 * reuses an existing certificate when it still covers the host and regenerates
 * when it does not, so a changed address costs one extra startup and nothing
 * else. `certificates/` is gitignored via the `*.pem` rule.
 *
 * ── What the phone will still show, once ────────────────────────────────────
 * mkcert installs its root CA into THIS machine's trust store, not the
 * phone's, so the phone sees a certificate signed by an issuer it does not
 * know and warns. Proceeding past it is enough — the origin is https either
 * way, which is all `getUserMedia` asks. To silence it for good, install
 * mkcert's rootCA.pem (path printed by `mkcert -CAROOT`) on the phone.
 *
 * Run with:  npm run dev:mobile
 */
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * This machine's LAN IPv4.
 *
 * Link-local 169.254.* addresses are skipped deliberately: Windows keeps them
 * on disconnected virtual adapters, they sort ahead of the real one often
 * enough to matter, and nothing on the network can route to them.
 */
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

const host = lanAddress();
if (!host) {
    console.error(
        'No LAN address found — this machine looks offline.\n' +
            'Connect to the same Wi-Fi as the phone and try again.',
    );
    process.exit(1);
}

const port = process.env.PORT ?? '3002';

console.log(`\n  Open on the phone:  https://${host}:${port}`);
console.log('  Same Wi-Fi, and accept the certificate warning once.\n');

/**
 * Next's CLI is run as a plain .js file under THIS node, not through `npx`.
 *
 * On Windows `npx` is `npx.cmd`, and since the fix for CVE-2024-27980 Node
 * refuses to spawn a .cmd/.bat without `shell: true` — it throws `EINVAL`
 * before anything starts. Turning the shell on would fix the symptom while
 * handing argument quoting to cmd.exe, and one of these arguments is a path.
 * Resolving the entry point and running it directly avoids both problems, and
 * keeps the child on the same node binary as the parent.
 */
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const child = spawn(
    process.execPath,
    [nextBin, 'dev', '-H', host, '-p', port, '--experimental-https'],
    { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));

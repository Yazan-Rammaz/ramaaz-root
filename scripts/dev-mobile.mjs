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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

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

/**
 * A NAME instead of the address — `DEV_HOST=rootdash.local npm run dev:mobile`.
 *
 * ── Why this override exists: passkeys ──────────────────────────────────────
 * WebAuthn will not run on an IP address. Not "warns", not "degrades" — the RP
 * ID has to be a domain, and `192.168.1.100` is not one, so every ceremony on
 * the LAN address fails however good the code is. `getUserMedia` never cared
 * (it asks only for a secure context, which an IP over https satisfies), which
 * is why this script was happy with an address for as long as the camera was
 * the only thing that needed it.
 *
 * With a hosts entry pointing a name at this machine, the whole problem goes
 * away — and mkcert is what makes it stick: Next mints the certificate for
 * whatever `-H` says, and mkcert's root CA is already in THIS machine's trust
 * store, so the name is a genuinely valid https origin here. That matters
 * beyond tidiness: a certificate the browser merely tolerates is not good
 * enough for WebAuthn, so clicking through a warning would not have worked.
 *
 * Steps, once:
 *   1. Add to C:\Windows\System32\drivers\etc\hosts (as Administrator):
 *        192.168.1.100   rootdash.test
 *      …using this machine's own LAN address, printed below.
 *   2. npm run dev:mobile -- rootdash.test
 *   3. https://rootdash.test:3002
 *
 * ⚠️ THE ARGUMENT, NOT AN ENV PREFIX. `DEV_HOST=x npm run dev:mobile` is bash
 * syntax and this is a Windows project: in PowerShell that line sets nothing
 * and reports nothing, so the server comes up on the LAN address as if the
 * override had never been typed — and the only symptom is a certificate that
 * does not match the name, three steps later. `$env:DEV_HOST = 'x'` works, and
 * the positional argument works in every shell, which is why it is the one
 * written down.
 *
 * ⚠️ `.test`, NOT `.local`. `.local` is reserved for mDNS, and on Windows and
 * macOS alike the resolver may send those names to mDNS EXCLUSIVELY — the hosts
 * entry is then ignored and the name resolves to something else or to nothing,
 * intermittently, depending on what else is on the network. `.test` is reserved
 * by RFC 6761 for exactly this, goes through the normal resolver, and is not in
 * the Public Suffix List, so it is a valid RP ID.
 *
 * ⚠️ AND THE CERTIFICATE MUST COVER THE NAME. Next reuses `certificates/*.pem`
 * when they exist, so changing the host does NOT by itself mint a new one — the
 * server comes up presenting the old certificate, the browser says "Not
 * secure", and a merely-tolerated certificate is one WebAuthn refuses. Delete
 * `certificates/*.pem` after changing DEV_HOST and let them regenerate.
 *
 * ⚠️ ON A PHONE this needs two more things, and neither is optional: the name
 * has to RESOLVE there (a phone has no hosts file — use the router's DNS, or
 * this machine's own mDNS name, `<computer-name>.local`), and the phone has to
 * TRUST mkcert's root CA (`mkcert -CAROOT`, installed as a profile). Without
 * the second, the phone gets a certificate warning, and a bypassed warning is
 * exactly the "tolerated, not valid" case WebAuthn refuses.
 */
const host = process.argv[2] || process.env.DEV_HOST || lanAddress();
if (!host) {
    console.error(
        'No LAN address found — this machine looks offline.\n' +
            'Connect to the same Wi-Fi as the phone and try again.',
    );
    process.exit(1);
}

const port = process.env.PORT ?? '3002';

/**
 * Throw away a certificate that does not cover the host we are about to serve.
 *
 * ⚠️ THE FAILURE THIS PREVENTS IS SILENT AND MISLEADING. Next reuses
 * `certificates/*.pem` when they exist. Point the server at a name it has never
 * served and it starts anyway, presenting the certificate it already had — so
 * the browser shows "Not secure" for a name mismatch, and the natural reading
 * is that the name is wrong, or the hosts file is wrong, or mkcert is broken.
 * None of those. The certificate is simply older than the decision to use a
 * name.
 *
 * It matters more than a warning triangle here: WebAuthn refuses an origin
 * whose certificate is merely TOLERATED, so this is the difference between the
 * passkey working and not existing.
 *
 * Deleting is safe — the pair is gitignored and Next mints a new one on the
 * next start, including this host.
 */
function dropStaleCertificate(name) {
    const dir = new URL('../certificates/', import.meta.url);
    const cert = fileURLToPath(new URL('localhost.pem', dir));
    const key = fileURLToPath(new URL('localhost-key.pem', dir));

    if (!existsSync(cert)) return;

    try {
        const { subjectAltName } = new X509Certificate(readFileSync(cert));
        // SANs read as `DNS:a, IP Address:b`. A plain substring test would
        // match `rootdash.test` inside `not-rootdash.test`, so compare entries.
        const covered = (subjectAltName ?? '')
            .split(',')
            .map((entry) => entry.trim().replace(/^(DNS|IP Address):/, ''))
            .includes(name);
        if (covered) return;

        console.log(
            `\n  Certificate does not cover ${name} — regenerating.\n` +
                `  (it had: ${subjectAltName ?? 'nothing'})`,
        );
    } catch {
        // Unreadable or not a certificate. Either way it cannot be trusted to
        // cover anything, and a fresh one costs one startup.
    }

    rmSync(cert, { force: true });
    rmSync(key, { force: true });
}

dropStaleCertificate(host);

const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

console.log(`\n  Open on the phone:  https://${host}:${port}`);
console.log('  Same Wi-Fi, and accept the certificate warning once.');

if (isAddress) {
    // Said here rather than left to fail silently on the screen: the passkey
    // control simply does not render on an IP origin (see passkey.ts), and a
    // missing button is the hardest kind of thing to go looking for.
    const lan = lanAddress();
    console.log(
        `\n  ⚠️  Passkeys are OFF at this address — WebAuthn needs a domain,\n` +
            `      and ${host} is not one. To test Face ID / Hello:\n` +
            `        hosts:  ${lan ?? '<this machine>'}   rootdash.test\n` +
            `        then:   rm certificates/*.pem\n` +
            `        run:    DEV_HOST=rootdash.test npm run dev:mobile\n` +
            `      Or just use http://localhost:${port} on this machine.\n`,
    );
} else {
    console.log('');
}

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

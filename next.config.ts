import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// next-intl: cookie-based locale (no URL routing). Points at our request config.
const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

const nextConfig: NextConfig = {
    reactStrictMode: true,
    // Don't advertise the framework.
    poweredByHeader: false,
    // Let phones on the LAN hit `npm run dev:mobile` without Next blocking the
    // cross-origin dev-asset requests. Subnet wildcards survive DHCP IP changes
    // (Wi-Fi 192.168.1.* / Windows mobile-hotspot 192.168.137.*).
    // Camera work has to happen on a phone, and getUserMedia refuses a
    // non-secure context — so a LAN IP over plain http cannot open the camera
    // at all. A cloudflared quick tunnel gives a real https origin the phone
    // trusts without installing a certificate, hence the trycloudflare entry.
    // `192.168.1.100` is this machine's current Wi-Fi address, listed
    // explicitly on request. It is already matched by the `192.168.1.*`
    // wildcard above it — verified by serving a `/_next/static` chunk with that
    // Origin header and getting 200, not a block — so it is belt-and-braces,
    // and the wildcard is what keeps working after DHCP hands out a new one.
    allowedDevOrigins: [
        '192.168.1.*',
        '192.168.1.100',
        '192.168.137.*',
        '*.trycloudflare.com',
    ],
    // Pin the workspace root (a stray lockfile exists in the home dir).
    turbopack: {
        root: import.meta.dirname,
    },
};

export default withNextIntl(nextConfig);

// Makes Cloudflare bindings (env vars, KV, R2, …) available during `next dev`.
initOpenNextCloudflareForDev();

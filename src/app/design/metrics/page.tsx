import type { Viewport } from 'next';
import { MetricsReadout } from './MetricsReadout';

/**
 * /design/metrics — what the device really gives us. Dev-only (the /design
 * layout gates it). Reach it from a phone with `npm run dev:mobile`.
 *
 * `viewportFit: 'cover'` is required and not cosmetic: without it the document
 * stops short of the notch and the home indicator, `env(safe-area-inset-*)`
 * resolves to 0, and the readout would confidently report no insets on a device
 * that has two. The root layout deliberately does not set it — this page
 * overrides it for itself only.
 */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
};

export default function MetricsPage() {
    return <MetricsReadout />;
}

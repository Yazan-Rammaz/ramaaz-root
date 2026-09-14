import type { Metadata, Viewport } from 'next';
import { Quicksand } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { localeDirection } from '@/lib/i18n/config';
import { SplashGate } from '@/features/splash/components/SplashGate';
import { Observe } from '@/components/Observe';
import { readChallenge } from '@/lib/auth/challenge';
import './globals.css';

// Project typeface. Quicksand covers Latin; Arabic falls back to the system
// sans (see globals.css font stack) until an Arabic face is added.
const appSans = Quicksand({
    variable: '--font-app-sans',
    subsets: ['latin'],
    display: 'swap',
});

export const metadata: Metadata = {
    title: 'Ramaaz Root',
    description: 'Agent bank & country manager administration',
};

// Let the design system own scaling — disable the browser's user zoom fighting
// our viewport-driven rem engine, but keep it accessible (maximumScale allowed).

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    // Mobile soft keyboard: OVERLAY it on top of the layout instead of resizing
    // the viewport. The browser then never scrolls the page to chase the focused
    // input — the layout stays put and the keyboard simply covers the reserved
    // gray space at the bottom (auth screens own that space). Without this the
    // default `resizes-visual` makes the page jump to the top on focus.
    interactiveWidget: 'overlays-content',
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // The locale comes from the cookie (resolved by next-intl). `dir` is derived
    // once here — the ONLY place direction is set. Components stay direction-
    // agnostic via logical utilities (see AGENTS.md §10).
    const locale = await getLocale();

    // Read server-side and handed to the collector: the challenge lives in an
    // httpOnly cookie, so the browser cannot label its own session with the id
    // the backend logs quote. An identifier, not a credential — the challenge
    // TOKEN beside it never leaves the server.
    const { challengeId } = await readChallenge();

    return (
        <html
            lang={locale}
            dir={localeDirection(locale)}
            className={`${appSans.variable} h-full antialiased`}
        >
            <body className="bg-background text-foreground flex min-h-full flex-col">
                {/* First, so its console and fetch hooks are installed before
                    any screen below can throw. Renders nothing. */}
                <Observe correlation={challengeId} />
                <NextIntlClientProvider>{children}</NextIntlClientProvider>
                {/* Covers every full page load / refresh — see SplashGate. */}
                <SplashGate />
            </body>
        </html>
    );
}

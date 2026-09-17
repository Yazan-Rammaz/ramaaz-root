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
            {/*
              NO `min-h-full` here. It looks harmless next to the `height: 100svh`
              globals.css gives this element, and it silently defeats it.

              `body` is `position: fixed`, so a percentage height resolves against
              the INITIAL CONTAINING BLOCK — which on iOS is the LARGE viewport,
              the height the page would have if the browser's toolbar were hidden.
              `min-height` then beats `height`, so the shell laid out ~100-150px
              taller than the part you can actually see. That is the exact bug the
              comment above `body` in globals.css says it fixed, reintroduced from
              a second file.

              What it cost: every screen below is height-bounded by this element,
              and the ID capture screen's spacers and viewfinder shrink to fit that
              bound (see FlexSpace). Laid out against the large viewport there was
              no shortfall to absorb, so nothing shrank, the frame stayed at its
              full 350x400 — and "Your Privacy Is Completely Safe" and the "Start
              Live Detection Your ID" button were pushed behind the browser bar.
              Safari's bar is thin, so half the button showed; Chrome's is tall, so
              neither did.

              Nothing needs it: the element is fixed and `overflow: hidden`, so it
              cannot scroll or grow whatever this says. The dashboard scrolls in
              its own `overflow-auto` main, not here.
            */}
            <body className="bg-background text-foreground flex flex-col">
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

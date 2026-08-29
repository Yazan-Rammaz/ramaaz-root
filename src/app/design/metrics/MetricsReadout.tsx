'use client';

import { useEffect, useState } from 'react';

/**
 * What this browser, on this device, is actually giving the page.
 *
 * Open it on the phone — `npm run dev:mobile` serves the LAN over https, which
 * iOS requires — and read the numbers off the screen. They are the ones to put
 * in `DEVICES` in catalog.ts; everything else is a guess, and a guessed viewport
 * height is exactly the number a design gallery must not invent.
 *
 * ── Why several heights, not one ────────────────────────────────────────────
 * They disagree, and the disagreement IS the answer:
 *
 *   screen.height      the panel. What a spec sheet says. Never what you get.
 *   innerHeight        the layout viewport — what `100vh` and `h-full` resolve
 *                      to. This is the number a screen has to fit in.
 *   visualViewport     what is on screen right now. Shrinks under the keyboard
 *                      and grows as Safari's toolbar collapses on scroll, so it
 *                      moves while innerHeight does not.
 *   safe-area insets   the strips Safari will draw its own chrome over.
 *
 * Read `innerHeight` for the preset. Read the insets to know how much of a
 * bleeding layout is hidden behind the notch and the home indicator.
 */
export function MetricsReadout() {
    const [m, setM] = useState<Record<string, string> | null>(null);

    useEffect(() => {
        const read = () => {
            const cs = getComputedStyle(document.documentElement);
            const probe = getComputedStyle(document.getElementById('safe-probe')!);
            const rootPx = parseFloat(cs.fontSize);
            setM({
                'screen (device)': `${screen.width} × ${screen.height}`,
                'devicePixelRatio': String(devicePixelRatio),
                'innerWidth × innerHeight': `${innerWidth} × ${innerHeight}`,
                'visualViewport': visualViewport
                    ? `${Math.round(visualViewport.width)} × ${Math.round(visualViewport.height)}`
                    : 'unsupported',
                'safe-area top / bottom': `${probe.paddingTop} / ${probe.paddingBottom}`,
                'safe-area start / end': `${probe.paddingLeft} / ${probe.paddingRight}`,
                'root font-size': `${rootPx}px`,
                '1 XD px renders as': `${Math.round((rootPx / 16) * 1000) / 1000}px`,
                'orientation': innerWidth > innerHeight ? 'landscape' : 'portrait',
            });
        };

        // A frame's delay so the first paint has settled and the effect does not
        // set state synchronously (the project's react-hooks rule).
        const raf = requestAnimationFrame(read);
        addEventListener('resize', read);
        addEventListener('orientationchange', read);
        visualViewport?.addEventListener('resize', read);
        return () => {
            cancelAnimationFrame(raf);
            removeEventListener('resize', read);
            removeEventListener('orientationchange', read);
            visualViewport?.removeEventListener('resize', read);
        };
    }, []);

    return (
        <div className="flex min-h-full flex-col p-20">
            {/* The insets are only readable off a real element: env() resolves to
                0 anywhere it is not applicable, and only reports true values when
                the document opted into viewport-fit=cover (see page.tsx). */}
            <div
                id="safe-probe"
                aria-hidden
                className="pointer-events-none fixed top-0 h-1 w-1 opacity-0"
                style={{
                    paddingTop: 'env(safe-area-inset-top)',
                    paddingBottom: 'env(safe-area-inset-bottom)',
                    paddingLeft: 'env(safe-area-inset-left)',
                    paddingRight: 'env(safe-area-inset-right)',
                }}
            />

            <h1 className="fz-20 font-bold text-[#1D1D1D]">Device metrics</h1>
            <p className="fz-13 mt-6 text-[#707070]">
                Open this on the device. Put <b>innerWidth × innerHeight</b> into DEVICES in
                catalog.ts — that is the box a screen actually has to fit.
            </p>

            <div className="mt-20 flex flex-col gap-2">
                {m ? (
                    Object.entries(m).map(([k, v]) => (
                        <div
                            key={k}
                            className="fz-14 flex items-baseline justify-between gap-12 py-6"
                            style={{ borderBottom: '1px solid #ececec' }}
                        >
                            <span className="text-[#707070]">{k}</span>
                            <span className="font-bold text-[#1D1D1D]">{v}</span>
                        </div>
                    ))
                ) : (
                    <span className="fz-14 text-[#707070]">measuring…</span>
                )}
            </div>

            <p className="fz-12 mt-20 leading-normal text-[#707070]">
                Scroll the page: on iOS, Safari&apos;s toolbar collapses and{' '}
                <b>visualViewport</b> grows while <b>innerHeight</b> stays put. The smaller of
                the two is what a screen must survive.
            </p>
        </div>
    );
}

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
/** Guarded so the first render (before the effect, and on the server) is safe. */
function innerWidthSafe() {
    return typeof window === 'undefined' ? '' : String(window.innerWidth);
}

export function MetricsReadout() {
    const [m, setM] = useState<Record<string, string> | null>(null);
    /**
     * The SMALLEST viewport seen while this page has been open — and the number
     * that actually matters.
     *
     * `innerHeight` is not one value. Safari's toolbar collapses on scroll and
     * comes back; a call, a screen recording or a personal hotspot grows the
     * status bar and takes the difference out of the page. A single reading
     * describes one of those moments and silently misses the tightest one,
     * which is exactly the moment a layout breaks in.
     *
     * So: put the phone in the worst state you care about — on a call, toolbar
     * showing — and this remembers it. That figure is what to type into the
     * gallery, and what belongs in DEVICES.
     */
    const [minH, setMinH] = useState<number | null>(null);

    useEffect(() => {
        const read = () => {
            setMinH((prev) => (prev === null ? innerHeight : Math.min(prev, innerHeight)));
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
                Open this on the device, put it in the worst state you care about — on a
                call, toolbar showing — then type the figure below into the gallery&apos;s W
                and H boxes. At that size the gallery is pixel-identical to the real page.
            </p>

            {/* The headline number: the tightest viewport seen so far. */}
            <div
                className="mt-16 rad-15 px-16 py-14"
                style={{ background: '#F4F7FF', border: '1px solid #D6E2FF' }}
            >
                <p className="fz-11 text-[#3066CC]">Use this in the gallery</p>
                <p className="fz-28 mt-4 font-bold text-[#1D1D1D]">
                    {minH === null ? '…' : `${innerWidthSafe()} × ${minH}`}
                </p>
                <p className="fz-11 mt-4 text-[#707070]">
                    smallest height seen while this page has been open — scroll, take a call,
                    and watch it drop
                </p>
            </div>

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

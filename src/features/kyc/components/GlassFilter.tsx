'use client';

import { GLASS_DISPLACEMENT_MAP } from '@/features/kyc/config/glassMap';

/**
 * The refraction filter behind every pane of glass in this app.
 *
 * ── Why a baked map and not turbulence ──────────────────────────────────────
 * An earlier version displaced against `feTurbulence`, which is random noise,
 * and the result was a rippled surface — a puddle, not a pane. Real glass does
 * not ripple: it bends light smoothly, hardest at the edges where the material
 * is thickest and not at all through the middle.
 *
 * `GLASS_DISPLACEMENT_MAP` is that shape, baked once as a PNG: red encodes how
 * far to shift horizontally, green vertically, and the gradient runs from
 * neutral in the centre to full deflection at the rim. `feImage` brings it in
 * and `feDisplacementMap` reads those channels.
 *
 * ── Why three displacements and not one ─────────────────────────────────────
 * Chromatic aberration, and it is most of what sells it. A lens does not bend
 * every wavelength equally, so a real edge fringes — red, green and blue
 * separate slightly. Each channel is displaced by a DIFFERENT amount, isolated
 * with `feColorMatrix`, then the three are recombined with `screen` blends.
 *
 * One displacement gives a distorted picture. Three give glass.
 *
 * ⚠️ `color-interpolation-filters="sRGB"`. Filters default to linearRGB, where
 * the three channel blends composite to something muddy and dark. This is not
 * a preference; without it the pane is visibly wrong.
 *
 * ── How it is used ──────────────────────────────────────────────────────────
 * Referenced from `backdrop-filter: url(#id)`, never `filter:` — the point is
 * to bend what is BEHIND the element. See `.verdict-glass` in globals.css.
 */
export function GlassFilter({
    id,
    /**
     * Displacement strength. 0 is a flat pane; the channel offsets below are
     * scaled from it and stay in their fixed ratio, which is what keeps the
     * fringing looking like one lens rather than three overlaid pictures.
     */
    scale,
    /** Softening applied INSIDE the filter, after the channels recombine. */
    blur,
}: {
    id: string;
    scale: number;
    blur: number;
}) {
    return (
        /*
         * ⚠️ RENDERED BUT INVISIBLE — never `display: none`.
         *
         * A filter referenced from `filter:` resolves fine from a hidden SVG,
         * which is the usual trick and is why this looked safe once. A
         * `backdrop-filter` reference does not: it has to resolve against a
         * rendered element, and when it fails the url() is invalid — which
         * invalidates the WHOLE declaration, taking the saturation and the
         * frost with it. The symptom is not a pane missing its refraction, it
         * is no pane at all, and nothing in the console.
         */
        <svg aria-hidden className="verdict-glass-filter" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter
                    id={id}
                    colorInterpolationFilters="sRGB"
                    x="0%"
                    y="0%"
                    width="100%"
                    height="100%"
                >
                    <feImage
                        x="0"
                        y="0"
                        width="100%"
                        height="100%"
                        preserveAspectRatio="none"
                        result="map"
                        href={GLASS_DISPLACEMENT_MAP}
                    />

                    {/* Red, green and blue displaced by 1 : 1.2 : 1.4. The
                        ratio is the aberration; the magnitude is `scale`. */}
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="map"
                        result="dispRed"
                        scale={-scale}
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                    <feColorMatrix
                        in="dispRed"
                        type="matrix"
                        values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                        result="red"
                    />

                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="map"
                        result="dispGreen"
                        scale={-scale * 1.2}
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                    <feColorMatrix
                        in="dispGreen"
                        type="matrix"
                        values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                        result="green"
                    />

                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="map"
                        result="dispBlue"
                        scale={-scale * 1.4}
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                    <feColorMatrix
                        in="dispBlue"
                        type="matrix"
                        values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                        result="blue"
                    />

                    {/* `screen` recombines the three isolated channels without
                        darkening — each holds one channel and black elsewhere,
                        so screening adds them back into one picture. */}
                    <feBlend in="red" in2="green" mode="screen" result="rg" />
                    <feBlend in="rg" in2="blue" mode="screen" result="output" />

                    <feGaussianBlur in="output" stdDeviation={blur} />
                </filter>
            </defs>
        </svg>
    );
}

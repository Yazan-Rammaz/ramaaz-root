'use client';

import { useId } from 'react';
import { GlassFilter } from '@/features/kyc/components/GlassFilter';
import { CAPTURE_PHOTO_GLASS, MIRROR_CLASS } from '@/features/kyc/config/capture';

/**
 * A pane of glass over a still photograph.
 *
 * The one implementation of the material in this app — the checking pane, the
 * intro photo and the comparison stage are all this component at different
 * strengths. The layers and what each is for are documented at `.verdict-glass`
 * in globals.css; the numbers live in `CAPTURE_PHOTO_GLASS` (§9b) and
 * `CAPTURE_CHECKING_GLASS` (§9) in config/capture.ts. Nothing to tune here.
 *
 * ── It has to be TOLD what is behind it ─────────────────────────────────────
 * The pane does not filter its backdrop — `backdrop-filter` silently renders
 * nothing on a machine that is not compositing on the GPU, which is a machine
 * setting and cost three rounds to establish. It draws a filtered COPY of the
 * picture instead, which is why `src` is required and why this cannot be
 * dropped over arbitrary page content. Wherever it is used, the thing behind it
 * is one image we already have.
 *
 * ── How to place it ─────────────────────────────────────────────────────────
 * It renders absolutely, so the caller's frame must be positioned, must clip,
 * and must pass its OWN radius in `className`:
 *
 *     <div className="relative w-130 h-148 rad-20 overflow-hidden">
 *         <img src={photo} className="h-full w-full object-cover" />
 *         <PhotoGlass src={photo} width={130} className="rad-20" />
 *     </div>
 *
 * ⚠️ The radius is not decoration. Without it the pane's rim is a rectangle
 * clipped square by the parent's rounded corners, and the bevel — the one layer
 * carrying the material — dies exactly at the corners where glass is most
 * obviously glass.
 *
 * ⚠️ The copy must register with the picture underneath TO THE PIXEL: same
 * `object-cover`, same box, same mirroring. A copy that is off by a few pixels
 * reads as a misaligned cut-out rather than as a window.
 */
export function PhotoGlass({
    src,
    width,
    amount = CAPTURE_PHOTO_GLASS.glass,
    mirrored = true,
    className = '',
    tuning,
    wave = false,
    waveFloor = 0,
}: {
    /**
     * The picture the pane stands over — the same string the sharp image below
     * it renders.
     *
     * ⚠️ `null`, never `''`. An empty `src` is not "no image": the browser
     * resolves it against the current URL and re-downloads the PAGE. With null
     * the lens is simply not drawn and the pane is frost over whatever the
     * frame's own background is, which is the honest thing to show when there
     * is no photograph.
     */
    src: string | null;
    /**
     * The pane's width in XD px — 130 on the intro, 300 on the comparison
     * stage, 350 on the camera frame.
     *
     * Every number in `CAPTURE_PHOTO_GLASS` is a fraction of this, because a
     * pane's numbers do not port between sizes: a frost that is a sheet across
     * a camera frame is a smear across a thumbnail. Ignored when `tuning` is
     * given.
     */
    width?: number;
    /**
     * How much pane, 0..100. Defaults to the §9b dial.
     *
     * It is the opacity of the whole pane, so 40 is a 40% sheet over 60% sharp
     * photograph — the picture stays legible through it, which is the point of
     * a dial rather than an on/off.
     */
    amount?: number;
    /**
     * Flip the copy exactly as the picture below it is flipped.
     *
     * True by default because every use of this so far stands over a face, and
     * every face in this flow is mirrored from `MIRROR_CLASS` — a copy that
     * disagrees with its original is a pane full of somebody else's face.
     */
    mirrored?: boolean;
    /** Must carry the frame's own `rad-*`. See above. */
    className?: string;
    /**
     * Explicit pane values in XD px, for a caller with its own tuned table.
     *
     * The checking pane is the one caller that has one (`CAPTURE_CHECKING_GLASS`,
     * tuned in /design/liveness-lab against real faces), and it predates the
     * ratios — which are derived FROM it. Everything else should pass a `width`
     * and take §9b.
     */
    tuning?: {
        warp: number;
        warpBlur: number;
        frostBlur: number;
        saturation: number;
        frost: number;
    };
    /**
     * Breathe the pane 0 → `amount` → 0 instead of holding it still.
     *
     * `amount` becomes the PEAK rather than the setting, so the picture is
     * briefly its sharp self at every trough. For a screen that is waiting on a
     * server with no progress to report, that is the honest thing to draw: it
     * says work is happening without implying how much is left.
     *
     * Only the frost travels — the refraction and the bevel hold, so the
     * material never blinks out. See `.verdict-glass--wave` in globals.css.
     */
    wave?: boolean;
    /**
     * How much glass is left at the BOTTOM of the wave — on the same 0..100
     * scale as `amount`, which is the top of it.
     *
     * So `amount={50} waveFloor={10}` travels between a tenth and a half, and
     * the pair reads the way the change was asked for rather than needing a
     * ratio worked out at the call site.
     *
     * 0 — the default — clears completely and the photograph is briefly sharp.
     * Raise it when the picture underneath is one the pane is there to WITHHOLD
     * rather than to dress: the checking pane hides a frozen face on purpose,
     * and a trough at zero would reveal it once per cycle.
     *
     * Clamped to `amount`; a floor above the peak would invert the wave.
     * Only meaningful with `wave`.
     */
    waveFloor?: number;
}) {
    /*
     * `filter: url(#id)` resolves against the DOCUMENT, so two panes on one
     * page with the same id would both take the first one's filter. A rendered
     * id per instance is the only thing that cannot collide.
     *
     * ⚠️ Stripped of punctuation. React's ids are `:r1:`, and a bare colon in
     * a `url(#…)` reference has to be escaped or the whole declaration is
     * invalid — which costs the pane its bend with nothing in the console.
     */
    const filterId = `glass-warp-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

    // Nothing to draw, and nothing mounted — not a transparent pane carrying an
    // expensive filter.
    if (amount <= 0) return null;

    const px = width ?? 350;
    const warp = tuning ? tuning.warp : px * CAPTURE_PHOTO_GLASS.warp;
    const warpBlur = tuning ? tuning.warpBlur : px * CAPTURE_PHOTO_GLASS.warpBlur;
    const saturation = tuning ? tuning.saturation : CAPTURE_PHOTO_GLASS.saturation;

    /*
     * ── THE DIAL SCALES WHAT THE GLASS HIDES, NOT WHETHER IT IS THERE ───────
     *
     * Two things were tried before this, and both failed in a way worth
     * recording because they are the two obvious implementations:
     *
     *   opacity on the pane      takes the BEVEL down with it, and the bevel is
     *                            the layer that says a pane exists at all. At
     *                            40% over a 130px thumbnail the DOM was
     *                            perfect and the screen showed a sharp photo.
     *   opacity on lens + tint   same failure, one layer further in: the copy
     *                            fades toward the sharp picture underneath, so
     *                            less dial means less glass AND less pane.
     *
     * What "less glass" actually means is a pane you can see MORE through — a
     * thinner sheet, not a fainter one. So the dial scales the two layers that
     * do the hiding, the frost's blur and the frost itself, and leaves
     * everything that makes it a material — refraction, fringing, saturation,
     * bevel — at full strength. At 50 the face is plainly legible behind
     * plainly visible glass, which is the thing neither version above could do.
     */
    const hide = amount / 100;
    const frostBlur = tuning ? tuning.frostBlur : px * CAPTURE_PHOTO_GLASS.frostBlur * hide;
    const frost = tuning ? tuning.frost : CAPTURE_PHOTO_GLASS.frost * hide;

    return (
        <>
            {/* The refraction. See GlassFilter — a baked lens map and three
                colour channels, not turbulence. At `warp: 0` it is not mounted
                and the pane falls back to its plain frost, which is the
                documented degradation and not a failure. */}
            {warp > 0 && <GlassFilter id={filterId} scale={warp} blur={warpBlur} />}

            <span
                aria-hidden
                className={`verdict-glass pointer-events-none absolute inset-0 ${
                    wave ? 'verdict-glass--wave ' : ''
                }${className}`}
                style={
                    {
                        '--glass-frost': frost,
                        '--glass-blur': `${frostBlur * 0.0625}rem`,
                        '--glass-saturation': saturation,
                        '--glass-warp': warp > 0 ? `url(#${filterId})` : 'none',
                        /*
                         * The peak the wave travels to. Only read by the
                         * keyframes, and only meaningful with `wave` — but set
                         * unconditionally, because a keyframe referencing a
                         * property that does not exist yields an invalid value
                         * and kills the animation silently.
                         */
                        '--glass-blur-max': `${frostBlur * 0.0625}rem`,
                        '--glass-frost-max': frost,
                        /*
                         * The keyframes scale the peak by this, so an absolute
                         * floor becomes a fraction here — once, rather than at
                         * every call site. Guarded against `amount: 0`, which
                         * never reaches this (the component returns null above)
                         * but would divide by zero if it ever did.
                         */
                        '--glass-wave-floor':
                            amount > 0 ? Math.min(waveFloor, amount) / amount : 0,
                    } as React.CSSProperties
                }
            >
                {/* ⚠️ NO `opacity` ON ANY OF THESE — see the note above the
                    `hide` factor. Every layer here renders at full strength and
                    the dial is already inside the frost values. */}
                {src && (
                    <span className="verdict-glass-lens">
                        {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
                        <img
                            src={src}
                            alt=""
                            className={`verdict-glass-source ${mirrored ? MIRROR_CLASS : ''}`}
                        />
                    </span>
                )}
                <span className="verdict-glass-tint" />
                <span className="verdict-glass-edge" />
            </span>
        </>
    );
}

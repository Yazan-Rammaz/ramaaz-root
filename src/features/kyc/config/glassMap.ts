/**
 * The displacement map every pane of glass refracts through.
 *
 * ── What a displacement map is ──────────────────────────────────────────────
 * A picture whose colour channels are read as DIRECTIONS rather than as colour.
 * `feDisplacementMap` samples this at each pixel and moves the backdrop by
 * `(R - 128) / 255 * scale` horizontally and the same from G vertically. So:
 *
 *   R = 128  no horizontal shift        R = 0    full shift one way
 *   G = 128  no vertical shift          R = 255  full shift the other
 *
 * ── The shape, and why it is this shape ─────────────────────────────────────
 * Both channels sit at a flat 128 through the middle and ramp to their extremes
 * at the edges. That is a LENS: nothing is moved through the centre, and the
 * deflection grows toward the rim where a real pane is thickest and bends light
 * hardest. The picture behind stays readable in the middle and curls at the
 * border, which is the whole visual signature of the material.
 *
 * It replaced `feTurbulence`, which is noise: every point deflected in a random
 * direction, giving a rippled surface. That reads as water, not glass — and no
 * amount of tuning fixes it, because the problem is the shape of the map and
 * not the strength of the effect.
 *
 * ── Why it is authored here and not a PNG ───────────────────────────────────
 * The usual version of this is a base64 PNG lifted from somewhere. Two reasons
 * not to:
 *
 *   - it cannot be read. A wall of base64 is unreviewable, and a single mangled
 *     character produces a map that decodes to something plausible-but-wrong or
 *     not at all — and a filter that produces nothing INVALIDATES the
 *     `backdrop-filter` referencing it, which silently removes the entire pane.
 *     That precise symptom has already been chased down three times here from
 *     three other causes.
 *   - the numbers below are the design. Wanting a softer falloff means moving a
 *     stop, which is a one-line change to something legible.
 *
 * Two linear gradients — R across, G down — composited with `screen`, which
 * adds them into one picture because each is black in the other's channel.
 */
const MAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <defs>
    <linearGradient id="x" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="rgb(0,0,0)"/>
      <stop offset="0.38" stop-color="rgb(128,0,0)"/>
      <stop offset="0.62" stop-color="rgb(128,0,0)"/>
      <stop offset="1" stop-color="rgb(255,0,0)"/>
    </linearGradient>
    <linearGradient id="y" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(0,0,0)"/>
      <stop offset="0.38" stop-color="rgb(0,128,0)"/>
      <stop offset="0.62" stop-color="rgb(0,128,0)"/>
      <stop offset="1" stop-color="rgb(0,255,0)"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" fill="url(#x)"/>
  <rect width="200" height="200" fill="url(#y)" style="mix-blend-mode:screen"/>
</svg>`;

/**
 * Inlined as a data URI rather than served from `/public`.
 *
 * `feImage` pointing at a URL is a second request that has to land before the
 * filter can produce anything — so the pane renders unrefracted for a frame and
 * then pops — and if it ever fails (a path typo, a cache miss, a CSP rule) the
 * filter produces nothing and takes the whole pane with it. Inlined it cannot
 * 404, cannot arrive late and cannot be blocked.
 *
 * `encodeURIComponent` rather than base64: it survives being read, and the
 * escaping is done once at module load.
 */
export const GLASS_DISPLACEMENT_MAP = `data:image/svg+xml,${encodeURIComponent(MAP_SVG)}`;

import type { CSSProperties } from "react";

/**
 * Exact dashed outline (XD default: Size 0.5, Dash 3, Gap 3, radius 12 — all XD
 * px that scale with the rem engine).
 *
 * Why not the `.hairline` dashed variant? CSS `border-style: dashed` gives the
 * browser control of the dash/gap length (you can't set them), and the hairline
 * pseudo-element is scaled 0.5 which halves and distorts those dashes. So dashed
 * borders can't match XD that way. This draws an SVG stroke instead, with
 * stroke-width / dash / gap / radius all expressed in rem so they land on the XD
 * pixel values AND scale 1:1 with every canvas like the rest of the system.
 *
 * This is the ONE way to draw a dashed border (hairline stays the one way for
 * solid). Fills its positioned parent — the parent must be `relative`.
 */
export function DashedFrame({
  radius = 12,
  color = "var(--color-line)",
  dash = 3,
  gap = 3,
  size = 0.5,
}: {
  /** Corner radius in XD px. */
  radius?: number;
  /** Stroke color (any CSS color / var). */
  color?: string;
  /** Dash length in XD px. */
  dash?: number;
  /** Gap length in XD px. */
  gap?: number;
  /** Stroke width in XD px. */
  size?: number;
}) {
  // 1 XD px = 0.0625rem (mirrors --spacing), so the outline scales with the root
  // font-size exactly like w-*/rad-* utilities.
  const rem = (px: number) => `${px * 0.0625}rem`;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      {/* Stroke sits on the box edge; its outer half (~0.25 XD px) overflows,
          which overflow-visible keeps from clipping. Geometry follows the
          element bounds (width/height 100%), so non-square boxes still work. */}
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        fill="none"
        stroke={color}
        style={
          {
            strokeWidth: rem(size),
            strokeDasharray: `${rem(dash)} ${rem(gap)}`,
            rx: rem(radius),
            ry: rem(radius),
          } as CSSProperties
        }
      />
    </svg>
  );
}

/**
 * FlexSpace — adaptive vertical spacer for full-height screens.
 *
 * A screen laid out from an XD frame has fixed gaps between its blocks. When the
 * viewport is shorter than the frame those gaps have to give somewhere, and the
 * XD file says *which* gaps give and by how much. FlexSpace carries both numbers:
 *
 *   size   the gap's height in XD pixels, straight off the frame
 *   share  how much of the shortfall this gap absorbs (0 = rigid, 1 = all of it).
 *          The shares down one screen should add up to 1.
 *
 * It is a plain flex item — `size` is the flex-basis and `share` the shrink
 * factor — so the browser distributes the shortfall itself. At or above the frame
 * height every spacer sits at exactly `size`.
 *
 * Only works inside a column flex container that is height-bounded (`h-full`).
 *
 * With `grow`, it instead eats all leftover space (`size`/`share` ignored).
 */
export function FlexSpace({
  size = 0,
  share = 0,
  grow = false,
}: {
  /** Gap height in XD pixels. */
  size?: number;
  /** Fraction of the vertical shortfall this gap absorbs (0–1). */
  share?: number;
  /** Fill the remaining space instead of holding a fixed height. */
  grow?: boolean;
}) {
  if (grow) {
    return <div aria-hidden className="w-full min-h-0 flex-1" />;
  }

  return (
    <div
      aria-hidden
      style={{
        // XD px -> scaling rem. 0.0625rem == 1px at the reference width.
        flexBasis: `${size * 0.0625}rem`,
        flexShrink: share,
        flexGrow: 0,
        minHeight: 0,
      }}
    />
  );
}

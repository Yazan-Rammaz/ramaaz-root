/**
 * FlexSpace — adaptive vertical spacer for full-height screens.
 *
 * A screen laid out from an XD frame has fixed gaps between its blocks. When the
 * viewport is shorter than the frame those gaps have to give somewhere, and the
 * XD file says *which* gaps give and by how much. FlexSpace carries both numbers:
 *
 *   size   the gap's height in XD pixels, straight off the frame
 *   share  this gap's flex-shrink factor (0 = rigid). Bigger = gives up more.
 *
 * It is a plain flex item — `size` is the flex-basis and `share` the shrink
 * factor — so the browser distributes the shortfall itself. At or above the frame
 * height every spacer sits at exactly `size`.
 *
 * ── `share` is NOT a fraction of the shortfall. Two traps ───────────────────
 *
 * 1. It is WEIGHTED BY SIZE. Flexbox distributes a deficit in proportion to
 *    `share x size`, not to `share`. A share of 0.65 on a 32px gap is a weight
 *    of 21; a share of 0.2 on a 400px frame is a weight of 80 — so the "frame
 *    takes a fifth" reading of those numbers is off by a factor of four.
 *
 * 2. SHRINK FACTORS MUST SUM TO >= 1, or the shortfall is only partly taken up.
 *    Per CSS Flexbox 9.7: when the unfrozen items' flex-shrink factors sum to
 *    less than one, the free space to distribute is MULTIPLIED by that sum. The
 *    leftover does not go anywhere — it overflows, and an ancestor with
 *    `overflow: hidden` silently eats it.
 *
 *    The trap is that the sum is re-checked after every item that bottoms out.
 *    A screen whose factors add to exactly 1 is fine only until the first
 *    spacer hits zero and freezes; from then on the survivors may add to less
 *    than 1 and absorption quietly stops partway. This is what hid the foot of
 *    the ID capture screen: 0.15 + 0.2 + 0.65 = 1, the 32px spacer collapsed,
 *    and the remaining 0.35 left 82px of the screen below the fold.
 *
 *    So give ONE item that can afford it a share of at least 1 — it is then
 *    able to finish the job alone no matter what else has frozen.
 *
 * Only works inside a column flex container that is height-bounded (`h-full`),
 * and only if that item can actually shrink (`min-h-0`; flex items default to
 * `min-height: auto`, which refuses to go below their content).
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
  /**
   * This gap's flex-shrink factor. 0 is rigid; bigger gives up more. NOT a
   * fraction — it is weighted by `size`, and the factors on a screen must sum
   * to at least 1. See the note above.
   */
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

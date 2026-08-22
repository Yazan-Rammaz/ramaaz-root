"use client";

import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { flagEmoji, type GeoNode } from "../mock-geo";

type Cell = { node: GeoNode; row: number; col: number; depth: number };

/**
 * The expandable countries tree (XD "Fixes" frame). Rendered as ONE grid so
 * every branch shares the same 50px row bands: countries and their level-1
 * divisions stack in the first column; each deeper level opens as a new
 * column toward the end side, its first child on the parent's own row. One
 * node per depth can be open at a time (accordion) — expanding a sibling
 * collapses the previous branch, so columns never collide.
 */
export function CountryTree({
  countries,
  path,
  onPathChange,
  onSelectNode,
}: {
  countries: GeoNode[];
  /** The chain of expanded node ids by depth, e.g. ["tr", "ist", "sariyer"].
      Controlled by the page so adding a value can auto-reveal its branch. */
  path: string[];
  onPathChange: (path: string[]) => void;
  /** Name click — opens the node's detail sheet (chevron only expands). */
  onSelectNode: (id: string) => void;
}) {
  const toggle = (depth: number, id: string) =>
    onPathChange(
      path[depth] === id ? path.slice(0, depth) : [...path.slice(0, depth), id],
    );

  // Place every visible node on the shared grid. Depths 0 and 1 (countries
  // and their level-1 divisions) stack together in column 0; depth 2+ always
  // opens its own new column starting at the parent's row (the design's
  // "country/division inline, everything deeper branches sideways" rule).
  const cells: Cell[] = [];
  let maxCol = 0;
  let row = 0;
  const placeBranch = (nodes: GeoNode[], depth: number, col: number, startRow: number) => {
    let r = startRow;
    for (const n of nodes) {
      cells.push({ node: n, row: r, col, depth });
      maxCol = Math.max(maxCol, col);
      if (path[depth] === n.id && n.children.length) placeBranch(n.children, depth + 1, col + 1, r);
      r++;
    }
  };
  const placeSameColumn = (nodes: GeoNode[], depth: number) => {
    for (const n of nodes) {
      const r = row++;
      cells.push({ node: n, row: r, col: 0, depth });
      if (path[depth] !== n.id || !n.children.length) continue;
      if (depth === 0) placeSameColumn(n.children, 1);
      else placeBranch(n.children, depth + 1, 1, r);
    }
  };
  placeSameColumn(countries, 0);

  return (
    <div
      className="mt-12 grid justify-start gap-x-8 gap-y-4 ps-12"
      style={{
        gridTemplateColumns: `repeat(${maxCol + 1}, max-content)`,
        // Branch columns can outrun the first column; keep every band 50px.
        gridAutoRows: "3.125rem",
      }}
    >
      {cells.map((cell) => (
        <GeoRow
          key={cell.node.id}
          cell={cell}
          expanded={path[cell.depth] === cell.node.id}
          onToggle={() => toggle(cell.depth, cell.node.id)}
          onSelect={() => onSelectNode(cell.node.id)}
        />
      ))}
    </div>
  );
}

function GeoRow({
  cell,
  expanded,
  onToggle,
  onSelect,
}: {
  cell: Cell;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const { node, depth } = cell;
  const expandable = node.children.length > 0;

  return (
    <div
      className="flex items-center gap-4"
      style={{ gridRow: cell.row + 1, gridColumn: cell.col + 1 }}
    >
      {/* Country: flag chip. */}
      {depth === 0 && (
        <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
          {node.flag ? (
            <Icon name={node.flag.icon} width={node.flag.w} height={node.flag.h} />
          ) : (
            <span className="fz-24 leading-none">{flagEmoji(node.code ?? "")}</span>
          )}
        </span>
      )}

      {/* Country / level-1: short-code chip (+ plate chip). */}
      {depth <= 1 && (
        <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
          {node.code}
        </span>
      )}
      {depth === 1 && (
        <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
          {node.plate}
        </span>
      )}

      {/* Map thumbnail — wide box on the first column, square chip deeper. */}
      <span
        className={cn(
          "bg-surface rad-12 grid h-50 shrink-0 place-items-center",
          depth <= 1 ? "w-110" : "w-50",
        )}
      >
        {node.map && (
          <Icon name={node.map.icon} width={node.map.w} height={node.map.h} />
        )}
      </span>

      {/* Name — clicking it opens the node's detail sheet; the chevron
          (only on rows with children) toggles the branch. */}
      <span
        className={cn(
          "bg-surface rad-12 flex h-50 items-center gap-8 px-12",
          depth <= 1 ? "w-200" : "w-160",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="fz-14 text-ink min-w-0 flex-1 truncate text-start"
        >
          {node.name}
        </button>
        {expandable && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={node.name}
            onClick={onToggle}
            className="shrink-0 p-2"
          >
            <Icon
              name="regions/chevron"
              size={12}
              mask
              className={cn(
                "text-muted block",
                depth === 0
                  ? expanded && "rotate-180"
                  : "-rotate-90 rtl:rotate-90",
              )}
            />
          </button>
        )}
      </span>
    </div>
  );
}

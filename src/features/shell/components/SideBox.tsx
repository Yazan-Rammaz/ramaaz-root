"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";

/**
 * A 50×50 sidebar cell (icon 26×26), centered inside the 74-wide rail. `empty`
 * renders just the outlined slot; `indicator` draws the blue active bar on the
 * rail's edge (marks the current section).
 */
export function SideBox({
  icon,
  label,
  indicator,
  empty,
  onClick,
  href,
}: {
  icon?: string;
  label?: string;
  indicator?: boolean;
  empty?: boolean;
  /** Optional handler — slots without one are inert placeholders. */
  onClick?: () => void;
  /** A section of its own: the cell is a link to it. */
  href?: string;
}) {
  const className = cn(
    "hairline bg-background rad-12 flex h-50 w-50 items-center justify-center",
    empty && "cursor-default",
  );
  const style = { "--hairline-radius": "0.75rem" } as CSSProperties;
  return (
    <div className="relative">
      {href ? (
        <Link href={href} aria-label={label} className={className} style={style}>
          {icon && <Icon name={icon} size={26} />}
        </Link>
      ) : (
        <button
          type="button"
          aria-label={label}
          disabled={empty}
          onClick={onClick}
          className={className}
          style={style}
        >
          {icon && <Icon name={icon} size={26} />}
        </button>
      )}
      {indicator && (
        <span
          aria-hidden
          className="bg-primary absolute top-1/2 h-26 w-3 -translate-y-1/2 rounded-full"
          /* Sit on the rail's edge: 12 XD px = the gap between box and border. */
          style={{ insetInlineEnd: "-0.75rem" }}
        />
      )}
    </div>
  );
}

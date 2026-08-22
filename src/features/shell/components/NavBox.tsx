"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { cn } from "@/lib/utils/cn";

/**
 * A top-navbar section cell — icon only (50×50, no label). Selected (its route
 * is the current one): solid #5d5c5d hairline + the black tab SVG beneath.
 * Unselected: the project dashed outline in #8d8d8d. A cell with an `href`
 * navigates (Link); one without is shown but inert (route not built yet).
 */
export function NavBox({
  icon,
  label,
  href,
  selected,
}: {
  icon: string;
  label: string;
  href?: string;
  selected: boolean;
}) {
  const className = cn(
    "bg-surface rad-12 text-ink relative flex h-50 w-50 items-center justify-center",
    selected && "hairline",
  );
  const style = selected
    ? ({
        "--hairline-radius": "0.75rem",
        "--hairline-color": "#5d5c5d",
      } as CSSProperties)
    : undefined;

  const inner: ReactNode = (
    <>
      {!selected && <DashedFrame radius={12} color="#8d8d8d" />}
      <Icon name={icon} size={26} mask />
    </>
  );

  return (
    <div className="relative shrink-0">
      {href ? (
        <Link
          href={href}
          aria-label={label}
          aria-current={selected ? "page" : undefined}
          className={className}
          style={style}
        >
          {inner}
        </Link>
      ) : (
        <button type="button" aria-label={label} className={className} style={style}>
          {inner}
        </button>
      )}

      {/* Current-section marker (XD Group 16339): the exported 8×12 tab SVG. */}
      {selected && (
        <Icon
          name="nav/selected-tab"
          width={8}
          height={12}
          className="absolute start-1/2 top-full -translate-x-1/2"
        />
      )}
    </div>
  );
}

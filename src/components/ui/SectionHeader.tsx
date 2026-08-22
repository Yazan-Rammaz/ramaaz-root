import type { CSSProperties } from "react";
import { Icon } from "./Icon";

/**
 * The "System X" section header: a 50×50 outlined icon box + a filled #fcfcfc
 * strip carrying the title and count. Shared by the section screens (System
 * Projects, System Languages, …). The outline color is per-section (projects use
 * muted #c3c3c3, languages use brand-blue #388cff).
 */
export function SectionHeader({
  icon,
  title,
  count,
  borderColor = "var(--color-muted)",
}: {
  /** Icon file name, e.g. "nav/rocket". */
  icon: string;
  title: string;
  /** Count shown after the title — a number, or a string like "4 | 8". */
  count: number | string;
  /** Icon-box outline color (any CSS color / var). */
  borderColor?: string;
}) {
  return (
    <header className="flex items-center gap-4 ps-12 pe-12">
      <span
        className="bg-surface hairline text-ink rad-12 flex h-50 w-50 shrink-0 items-center justify-center"
        style={
          {
            "--hairline-radius": "0.75rem",
            "--hairline-color": borderColor,
          } as CSSProperties
        }
      >
        <Icon name={icon} size={26} mask />
      </span>
      <span className="bg-surface rad-12 flex h-50 flex-1 items-center ps-12">
        <span className="fz-14 text-ink font-medium">
          {title} {count}
        </span>
      </span>
    </header>
  );
}

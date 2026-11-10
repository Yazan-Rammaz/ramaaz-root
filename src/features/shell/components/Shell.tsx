import type { ReactNode } from "react";
import { Navbar } from "./Navbar";
import { ShellMain } from "./ShellMain";
import { Sidebar } from "./Sidebar";

/**
 * The dashboard's frame: the left rail, the top navbar, and the content region
 * pages render into. Built as flex (rail = fixed scaled width, content fills
 * the rest) so it fits every canvas with NO x/y scroll — the shape is held by
 * the scaling engine, not a fixed 1366×1024 box.
 *
 * ONE frame for every place it appears — the dashboard layout, the design
 * gallery, and /unlock (where it stands in for the page behind the lock) — so
 * they cannot drift apart.
 *
 * `lock-backdrop`: the element the lock's glass filters (globals.css). While a
 * PIN gate is up, this whole frame goes under the glass.
 */
export function Shell({
  systemCode,
  children,
}: {
  /** The selected system's code, or null when none is selected. */
  systemCode: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="lock-backdrop flex h-full w-full overflow-hidden">
      <Sidebar systemCode={systemCode} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar systemSelected={systemCode != null} />
        {/* Page content opens here. Long pages scroll INSIDE this region only. */}
        <ShellMain>{children}</ShellMain>
      </div>
    </div>
  );
}

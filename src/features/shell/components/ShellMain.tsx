"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAddAction } from "../add-action";

/**
 * The content region pages render into. Empty while the navbar's red X has
 * put the current page away (`hiddenAt`); the page stays mounted underneath,
 * so bringing it back keeps whatever was open in it.
 */
export function ShellMain({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const { hiddenAt } = useAddAction();
  return (
    <main className="thin-scroll relative min-h-0 flex-1 overflow-auto">
      <div className={hiddenAt === pathname ? "hidden" : "contents"}>{children}</div>
    </main>
  );
}

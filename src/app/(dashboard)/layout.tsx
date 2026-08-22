import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth/session";
import { AddActionProvider } from "@/features/shell/add-action";
import { IdleLock } from "@/features/auth/components/IdleLock";
import { Sidebar } from "@/features/shell/components/Sidebar";
import { Navbar } from "@/features/shell/components/Navbar";

/**
 * The app shell for the whole protected area: fixed left rail + top navbar, with
 * pages rendering in the fluid content region. Built as flex (rail = fixed
 * scaled width, content fills the rest) so it fits every canvas with NO x/y
 * scroll — the shape is held by the scaling engine, not a fixed 1366×1024 box.
 *
 * `requireSession()` is the authoritative auth gate (backend `/v1/me`).
 * <IdleLock> adds the UX lock: after 5 minutes without interaction it covers
 * the shell with the passcode gate. It does NOT sign anyone out — the session
 * stays live and the lock is dismissed by re-entering the passcode.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();

  return (
    <AddActionProvider>
      <IdleLock name={session.name} role={session.role} />
      <div className="flex h-full w-full overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Navbar />
          {/* Page content opens here. Long pages scroll INSIDE this region only.
              scrollbar-gutter reserves the scrollbar's width up front so a page
              crossing the scroll threshold (e.g. AI content revealing) doesn't
              shift everything horizontally when the bar appears. */}
          <main className="thin-scroll relative min-h-0 flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </AddActionProvider>
  );
}

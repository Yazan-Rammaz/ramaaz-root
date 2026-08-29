import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth/session";
import { AddActionProvider } from "@/features/shell/add-action";
import { Sidebar } from "@/features/shell/components/Sidebar";
import { Navbar } from "@/features/shell/components/Navbar";

/**
 * The app shell for the whole protected area: fixed left rail + top navbar, with
 * pages rendering in the fluid content region. Built as flex (rail = fixed
 * scaled width, content fills the rest) so it fits every canvas with NO x/y
 * scroll — the shape is held by the scaling engine, not a fixed 1366×1024 box.
 *
 * `requireSession()` is the authoritative auth gate (backend `/v1/me`).
 *
 * ── The idle lock is temporarily absent ─────────────────────────────────────
 * <IdleLock> used to cover the shell after 5 minutes idle, dismissed by the
 * 6-digit passcode. That passcode no longer exists — this protocol has no PIN —
 * and its replacement is a face re-verify, which needs a session-authenticated
 * face endpoint the backend does not expose yet (/v1/auth/face takes a
 * challenge token, and a locked screen has a session instead).
 *
 * The component itself survives, timer and all, and takes the gate as a prop.
 * Remount it here with the face gate when that endpoint lands. The navbar's
 * lock button still fires its event; nothing listens until then.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireSession();

  return (
    <AddActionProvider>
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

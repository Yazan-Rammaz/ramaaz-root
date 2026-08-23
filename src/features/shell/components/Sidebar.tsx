"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { SideBox } from "./SideBox";
import { logoutAction } from "@/features/auth/actions";

/**
 * Left rail (74 XD px wide, full height). Avatar + page slots at the top, the
 * utility group (chat / settings / active section) pinned to the bottom. Full
 * height + `justify` spacing means it fits any viewport with no Y scroll.
 */
export function Sidebar() {
  const t = useTranslations("shell");

  return (
    <aside className="hairline-e flex h-full w-74 shrink-0 flex-col items-center py-16">
      {/* User avatar (drop the real image in place of the glyph later).
          The plate — background + radius — belongs to this wrapper, not to
          avatar.svg, so the two can never disagree about colour or corner
          rounding at different sizes. */}
      <div className="bg-muted/40 rad-12 h-50 w-50 shrink-0 overflow-hidden">
        <Icon
          name="side/avatar"
          width={50}
          height={50}
          alt={t("side.avatar")}
          className="h-full w-full object-cover"
        />
      </div>

      {/* Top: current page + empty page slots. */}
      <div className="mt-16 flex flex-col items-center gap-8">
        <SideBox icon="side/dashboard" label={t("side.dashboard")} />
        <SideBox empty />
        <SideBox empty />
        <SideBox empty />
      </div>

      {/* Bottom: utilities + active section marker. */}
      <div className="mt-auto flex flex-col items-center gap-8">
        <SideBox icon="side/chat" label={t("side.chat")} />
        <SideBox icon="side/settings" label={t("side.settings")} />
        <SideBox icon="side/systems" label={t("side.systems")} indicator />
        {/* Sign out. The action revokes server-side, clears every auth cookie
            and returns through "/", which re-checks and lands on /login. */}
        <SideBox
          icon="side/logout"
          label={t("side.logout")}
          onClick={() => void logoutAction()}
        />
      </div>
    </aside>
  );
}

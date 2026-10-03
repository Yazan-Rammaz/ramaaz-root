"use client";

import { useTranslations } from "next-intl";
import { SideBox } from "./SideBox";
import { logoutAction } from "@/features/auth/actions";
import { Icon } from "@/components/ui/Icon";
import { sweepLegacyStorage } from "@/features/passcode/store";

/**
 * Left rail (74 XD px wide, full height). Avatar + page slots at the top, the
 * utility group (chat / settings / active section) pinned to the bottom. Full
 * height + `justify` spacing means it fits any viewport with no Y scroll.
 */
export function Sidebar() {
  const t = useTranslations("shell");

  return (
    <aside className="hairline-e flex h-full w-74 shrink-0 flex-col items-center py-16">
      {/* User avatar — ALWAYS the glyph, never the administrator's face. The
          portrait belongs to the lock screen, where it says who is being
          asked; on the rail it would sit on screen all day for anyone passing
          by to see. */}
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
            and returns through "/", which re-checks and lands on /login.

            Older builds kept the lock's portrait in this browser's storage
            (see passcode/store.ts), which a Server Action cannot reach — so
            the sweep happens here, first. */}
        <SideBox
          icon="side/logout"
          label={t("side.logout")}
          onClick={() => {
            sweepLegacyStorage();
            void logoutAction();
          }}
        />
      </div>
    </aside>
  );
}

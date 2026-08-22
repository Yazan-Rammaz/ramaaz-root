"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { SideBox } from "./SideBox";

/**
 * Left rail (74 XD px wide, full height). Avatar + page slots at the top, the
 * utility group (chat / settings / active section) pinned to the bottom. Full
 * height + `justify` spacing means it fits any viewport with no Y scroll.
 */
export function Sidebar() {
  const t = useTranslations("shell");

  return (
    <aside className="hairline-e flex h-full w-74 shrink-0 flex-col items-center py-16">
      {/* User avatar (replace side/avatar.svg with the real image later). */}
      <Icon
        name="side/avatar"
        width={50}
        height={50}
        alt={t("side.avatar")}
        className="rad-12 object-cover"
      />

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
      </div>
    </aside>
  );
}

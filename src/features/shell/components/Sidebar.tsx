"use client";

import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Reveal, RevealItem } from "@/components/motion/Reveal";
import { cn } from "@/lib/utils/cn";
import { SideBox } from "./SideBox";
import { logoutAction } from "@/features/auth/actions";
import { UserAvatar } from "@/features/passcode/components/UserAvatar";
import { sweepLegacyStorage } from "@/features/passcode/store";

/**
 * Left rail (74 XD px wide, full height). Avatar + page slots at the top, the
 * utility group (chat / settings / active section) pinned to the bottom. Full
 * height + `justify` spacing means it fits any viewport with no Y scroll.
 *
 * `systemCode` is the selected system's code (`rdb`), or null when none is.
 */
export function Sidebar({ systemCode }: { systemCode: string | null }) {
  const t = useTranslations("shell");
  // The Business Work Structure is a section of its own, opened from the cell
  // under the avatar; while it is open the blue marker moves there.
  const inWork = usePathname().startsWith("/work-structure");

  return (
    <aside className="hairline-e flex h-full w-74 shrink-0 flex-col items-center py-16">
      {/* User avatar — the Root administrator's own photo, under liquid glass
          (UserAvatar, the lock screen's same treatment), so it reads as who is
          signed in without showing the face plainly all day. No photo (or an
          expired link) keeps the glyph. Decided with the owner, 2026-11-10. */}
      {/* Once a system is selected the card grows downward to carry its code
          under the avatar — the shell always says which system it is on. */}
      <div
        className={cn("rad-12 w-50 shrink-0 overflow-hidden", systemCode && "hairline")}
        style={{ "--hairline-radius": "0.75rem" } as CSSProperties}
      >
        <div className="bg-muted/40 rad-12 relative h-50 w-50 overflow-hidden">
          <UserAvatar width={50} height={50} alt={t("side.avatar")} rounded="rad-12" />
        </div>
        <Reveal show={systemCode != null} axis="y">
          <RevealItem>
            <span
              className="fz-14 text-ink flex h-40 w-50 items-center justify-center truncate px-4 font-medium"
              title={systemCode ?? undefined}
            >
              {systemCode}
            </span>
          </RevealItem>
        </Reveal>
      </div>

      {/* Top: the systems list first — always there, it is where a system is
          picked — then the selected system's own sections (Work Structure,
          then empty slots), which unfold (top → bottom) once one is picked. */}
      <div className="pt-16">
        <SideBox icon="side/systems" label={t("side.systems")} href="/systems" indicator={!inWork} />
      </div>
      <Reveal show={systemCode != null} axis="y" className="items-center gap-8 pt-8">
        <RevealItem>
          <SideBox icon="side/work-structure" label={t("side.workStructure")} href="/work-structure" indicator={inWork} />
        </RevealItem>
        <RevealItem>
          <SideBox empty />
        </RevealItem>
        <RevealItem>
          <SideBox empty />
        </RevealItem>
      </Reveal>

      {/* Bottom: utilities and sign-out. */}
      <div className="mt-auto flex flex-col items-center gap-8">
        <SideBox icon="side/chat" label={t("side.chat")} />
        <SideBox icon="side/settings" label={t("side.settings")} />
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

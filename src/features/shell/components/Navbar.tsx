"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { useAddAction } from "../add-action";
import { NAV_ITEMS } from "../nav-items";
import { NavBox } from "./NavBox";

const RADIUS = { "--hairline-radius": "0.75rem" } as CSSProperties;

// Routes whose pages get the trailing "+" (add) control; everywhere else
// (dashboard, systems, …) the navbar ends at the section boxes.
const ADD_ROUTES = new Set(["/currencies", "/languages", "/regions"]);

/**
 * Top navbar: a close control, the STATIC "Systems" label box (brand-blue
 * outline), then the icon-only section boxes (one selected → solid outline +
 * black tab, the rest dashed) closed by the search box, and — on ADD_ROUTES
 * only — a trailing add. The row clips rather than scrolls so the shell never
 * gains an X scrollbar.
 */
export function Navbar() {
  const t = useTranslations("shell");
  // The active section follows the route (e.g. /languages → the translate box).
  const pathname = usePathname();
  // The trailing "+" opens the add drawer the CURRENT page registered (e.g.
  // Countries → ?add=country, Administrative Divisions → ?add=division); while
  // open it becomes an "X" that closes it (no close control inside the drawer).
  // Pages that registered nothing (no add modal designed yet) get an inert "+".
  const drawerOpen = useSearchParams().get("add") != null;
  const { href: addOpenHref, onClose } = useAddAction();
  // A client-state sheet (e.g. the country detail drawer) registers `onClose`
  // while it's open — the trailing "+" becomes an X for it too, same as the
  // URL-param add drawers (rendered as its own branch below, so the Link
  // branch only ever sees onClose null or drawerOpen true — i.e. `drawerOpen`
  // alone already tells that branch whether it's showing "close" or "add").
  const addHref = drawerOpen ? pathname : onClose ? null : addOpenHref;

  return (
    <nav className="flex items-center gap-8 px-12 py-16">
      {/* Close — closes whatever client-state sheet the current page
          registered (e.g. a detail drawer); inert otherwise. */}
      <button
        type="button"
        onClick={onClose ?? undefined}
        disabled={!onClose}
        aria-label={t("nav.close")}
        className="bg-surface hairline rad-12 flex h-50 w-50 shrink-0 items-center justify-center disabled:cursor-default"
        style={{ ...RADIUS, "--hairline-color": "var(--color-muted)" } as CSSProperties}
      >
        <Icon name="nav/close" size={18} />
      </button>

      {/* Systems — static label box (always shown, brand-blue outline). */}
      <div
        className="bg-surface hairline rad-12 text-ink flex h-50 shrink-0 items-center gap-8 px-16"
        style={{ ...RADIUS, "--hairline-color": "#388cff" } as CSSProperties}
      >
        <Icon name="nav/systems" size={26} mask />
        <span className="fz-14 font-medium">{t("nav.systems")}</span>
      </div>

      {/* Section items — icon only; clip HORIZONTALLY on narrow widths (no X
          scroll), but keep vertical visible so the selected tab shows below. */}
      <div className="flex min-w-0 flex-1 items-center gap-8 overflow-x-clip">
        {NAV_ITEMS.map((item) => (
          <NavBox
            key={item.id}
            icon={`nav/${item.id}`}
            label={t(`nav.${item.id}`)}
            href={item.href}
            selected={item.href ? pathname === item.href : false}
          />
        ))}

        {/* Search — solid box, closing the section group. */}
        <button
          type="button"
          aria-label={t("nav.search")}
          className="bg-surface hairline rad-12 flex h-50 w-50 shrink-0 items-center justify-center"
          style={{ ...RADIUS, "--hairline-color": "var(--color-muted)" } as CSSProperties}
        >
          <Icon name="nav/search" size={26} mask />
        </button>
      </div>

      {/* Add — dashed box, only on ADD_ROUTES; opens the add drawer the current
          page registered. While a drawer (URL-param OR client-state, e.g. the
          detail sheet) is open it shows an X and closes it. On ADD_ROUTES
          pages with no registered add action it stays visible but does
          nothing. */}
      {ADD_ROUTES.has(pathname) &&
        (onClose && !drawerOpen ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("nav.close")}
            className="bg-surface rad-12 relative flex h-50 w-50 shrink-0 items-center justify-center"
          >
            <Icon name="regions/close-x" size={26} mask />
          </button>
        ) : addHref ? (
          <Link
            href={addHref}
            aria-label={drawerOpen ? t("nav.close") : t("nav.add")}
            className="bg-surface rad-12 relative flex h-50 w-50 shrink-0 items-center justify-center"
          >
            {drawerOpen ? (
              <Icon name="regions/close-x" size={26} mask />
            ) : (
              <>
                <DashedFrame radius={12} color="#8d8d8d" />
                <Icon name="nav/add" size={26} mask />
              </>
            )}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            aria-label={t("nav.add")}
            aria-disabled="true"
            className="bg-surface rad-12 relative flex h-50 w-50 shrink-0 cursor-default items-center justify-center"
          >
            <DashedFrame radius={12} color="#8d8d8d" />
            <Icon name="nav/add" size={26} mask />
          </button>
        ))}
    </nav>
  );
}

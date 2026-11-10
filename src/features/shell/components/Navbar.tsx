"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { Reveal, RevealItem } from "@/components/motion/Reveal";
import { requestLock } from "@/features/auth/lock-flag";
import { useAddAction } from "../add-action";
import { NAV_ITEMS } from "../nav-items";
import { NavBox } from "./NavBox";

const RADIUS = { "--hairline-radius": "0.75rem" } as CSSProperties;

// Routes whose pages get the trailing "+" (add) control; everywhere else
// (dashboard, systems, …) the navbar ends at the section boxes.
const ADD_ROUTES = new Set([
  "/business-types",
  "/currencies",
  "/dashboard-types",
  "/languages",
  "/regions",
  "/roles",
  "/systems",
  "/work-structure",
]);

const rootItems = NAV_ITEMS.filter((item) => !item.project);
const projectItems = NAV_ITEMS.filter((item) => item.project);

/**
 * Top navbar: a close control, the STATIC "Systems" label box (brand-blue
 * outline), then the icon-only section boxes (one selected → solid outline +
 * black tab, the rest dashed) closed by the search box, and — on ADD_ROUTES
 * only — a trailing add. The row clips rather than scrolls so the shell never
 * gains an X scrollbar.
 *
 * With no system selected, only the systems box and search show: every other
 * section works on a selected system's data. Selecting one unfolds them.
 */
export function Navbar({ systemSelected }: { systemSelected: boolean }) {
  const t = useTranslations("shell");
  // The active section follows the route (e.g. /languages → the translate box).
  const pathname = usePathname();
  // The Business Work Structure is its own section (the sidebar cell under the
  // avatar): its name takes the blue box, and the project sections fold away.
  const inWork = pathname.startsWith("/work-structure");
  const navBox = (item: (typeof NAV_ITEMS)[number]) => (
    <NavBox
      key={item.id}
      icon={`nav/${item.id}`}
      label={t(`nav.${item.id}`)}
      href={item.href}
      selected={item.href ? pathname === item.href : false}
    />
  );
  // The trailing "+" opens the add drawer the CURRENT page registered (e.g.
  // Countries → ?add=country, Administrative Divisions → ?add=division); while
  // open it becomes an "X" that closes it (no close control inside the drawer).
  // Pages that registered nothing (no add modal designed yet) get an inert "+".
  const drawerOpen = useSearchParams().get("add") != null;
  const {
    href: addOpenHref,
    onClose,
    hideAdd,
    hiddenAt,
    setHiddenAt,
  } = useAddAction();
  // The red X puts the current page away: its content goes and the section
  // box keeps only its icon; pressing the box brings both back.
  const hidden = hiddenAt === pathname;
  // A client-state sheet (e.g. the country detail drawer) registers `onClose`
  // while it's open — the trailing "+" becomes an X for it too, same as the
  // URL-param add drawers (rendered as its own branch below, so the Link
  // branch only ever sees onClose null or drawerOpen true — i.e. `drawerOpen`
  // alone already tells that branch whether it's showing "close" or "add").
  const addHref = drawerOpen ? pathname : onClose ? null : addOpenHref;

  return (
    <nav className="flex items-center gap-8 px-12 py-16">
      {/* The red X and the section box, as one gapless group: everything that
          folds carries its own spacing inside its Reveal (`pe-8`, `ps-8`),
          so folding and unfolding move their neighbours smoothly. */}
      <div className="flex shrink-0 items-center">
        {/* Red X — puts the page away (content hidden, section box down to its
          icon). Folds away while the page is hidden; the box brings it back. */}
        <Reveal show={!hidden} axis="x">
          <RevealItem>
            <div className="pe-8">
              <button
                type="button"
                onClick={() => setHiddenAt(pathname)}
                aria-label={t("nav.hide")}
                className="hairline flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
                style={
                  {
                    ...RADIUS,
                    "--hairline-color": "var(--color-muted)",
                  } as CSSProperties
                }
              >
                <Icon name="nav/close" size={18} />
              </button>
            </div>
          </RevealItem>
        </Reveal>

        {/* The section box — Systems, or Business Work Structure (brand-blue
          outline). Icon-only while the page is hidden; pressing it then shows
          the page again. */}
        <button
          type="button"
          onClick={hidden ? () => setHiddenAt(null) : undefined}
          aria-label={inWork ? t("nav.workStructure") : t("nav.systems")}
          aria-expanded={!hidden}
          className={cn(
            "hairline flex h-50 min-w-50 shrink-0 items-center justify-center rad-12 bg-surface px-12 text-ink",
            hidden ? "cursor-pointer" : "cursor-default",
          )}
          style={{ ...RADIUS, "--hairline-color": "#388cff" } as CSSProperties}
        >
          <Icon
            name={inWork ? "side/work-structure" : "nav/systems"}
            size={26}
            mask={!inWork}
          />
          {/* A phone has no room for the word: the box becomes icon-only (the word stays for screen readers). */}
          {/* Its name unfolds from the icon, and folds back into it. */}
          <Reveal show={!hidden} axis="x">
            <RevealItem>
              <div className="ps-8 pe-4 phone:sr-only">
                <span className="fz-14 font-medium whitespace-nowrap">
                  {inWork ? t("nav.workStructure") : t("nav.systems")}
                </span>
              </div>
            </RevealItem>
          </Reveal>
        </button>
      </div>

      {/* Section items — icon only. Too narrow for all of them (a phone, a
          system selected), the strip scrolls sideways with no bar drawn, and
          on a phone its trailing edge fades so a half-shown icon reads as
          "more this way" instead of tucked under the "+".
          A horizontal scroller clips vertically too, so `pb-12` makes room
          INSIDE it for the selected tab below a box; `-mb-12` gives the
          height back so the row doesn't grow. No `gap`: the project group
          carries its own leading space (`ps-8`) so it folds to nothing, and
          the controls after it space themselves (`ms-8`). */}
      <div className="thin-scroll nav-strip-fade -mb-12 flex min-w-0 flex-1 items-center overflow-x-auto pb-12">
        {/* Every section box folds away while the page is hidden (red X) —
            only search and the lock stay. Each item carries its own leading
            space INSIDE what folds, so nothing jumps when the fold ends. */}
        <Reveal show={!inWork && !hidden} axis="x" className="items-center">
          {rootItems.map((item) => (
            <RevealItem key={item.id}>{navBox(item)}</RevealItem>
          ))}
        </Reveal>

        {/* Project sections — folded away until a system is selected, then
            unfold from the start edge (left→right, right→left in RTL). */}
        <Reveal
          show={systemSelected && !inWork && !hidden}
          axis="x"
          className="items-center"
        >
          {projectItems.map((item) => (
            <RevealItem key={item.id}>
              <div className="ps-8">{navBox(item)}</div>
            </RevealItem>
          ))}
        </Reveal>

        {/* Search — solid box, always closing the section group. */}
        <button
          type="button"
          aria-label={t("nav.search")}
          className="hairline ms-8 flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
          style={
            {
              ...RADIUS,
              "--hairline-color": "var(--color-muted)",
            } as CSSProperties
          }
        >
          <Icon name="nav/search" size={26} mask />
        </button>
      </div>

      {/* Add — dashed box, only on ADD_ROUTES; opens the add drawer the current
          page registered. While a drawer (URL-param OR client-state, e.g. the
          detail sheet) is open it shows an X and closes it. On ADD_ROUTES
          pages with no registered add action it stays visible but does
          nothing. */}
      {/* "+" / X and the lock, gapless: the "+" carries its own spacing, so
          it folds away (a hidden page has nothing to add) without the lock
          jumping. */}
      <div className="flex shrink-0 items-center">
        <Reveal show={!hidden && ADD_ROUTES.has(pathname)} axis="x">
          <RevealItem>
            <div className="pe-8">
              {onClose && !drawerOpen ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t("nav.close")}
                  className="relative flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
                >
                  <Icon name="regions/close-x" size={26} mask />
                </button>
              ) : hideAdd ? null : addHref ? (
                <Link
                  href={addHref}
                  aria-label={drawerOpen ? t("nav.close") : t("nav.add")}
                  className="relative flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
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
                  className="relative flex h-50 w-50 shrink-0 cursor-default items-center justify-center rad-12 bg-surface"
                >
                  <DashedFrame radius={12} color="#8d8d8d" />
                  <Icon name="nav/add" size={26} mask />
                </button>
              )}
            </div>
          </RevealItem>
        </Reveal>
        {/* Lock — at the end, beside the "+" / X. Covers the shell with the passcode gate immediately, without
          waiting out the 5-minute idle timer. No splash and no reload: the
          document is unchanged, only the overlay appears. */}
        <button
          type="button"
          onClick={requestLock}
          aria-label={t("nav.lock")}
          className="hairline flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
          style={
            {
              ...RADIUS,
              "--hairline-color": "var(--color-muted)",
            } as CSSProperties
          }
        >
          <Icon name="nav/lock" size={26} mask />
        </button>
      </div>
    </nav>
  );
}

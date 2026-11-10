"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import type { NameLanguage } from "@/features/language/names";
import { useAddAction } from "@/features/shell/add-action";
import type { Currency, CurrencyCategory } from "../schema";
import { CurrencyEditDrawer } from "./CurrencyEditDrawer";

const rem = (px: number) => `${px * 0.0625}rem`;

// The 4 category icons in Group 16347. `x` is each 50×50 filter button's start
// (XD px) inside the strip, centering it on the icon (centers 22/92/161/231).
// x = each 50-box's start (XD px). The first is clamped to 0 (not -3) so its
// left border isn't clipped by the strip's overflow; the icon sits ~centered.
const FILTERS: { category: CurrencyCategory; x: number }[] = [
  { category: "cash", x: 0 },
  { category: "crypto", x: 67 },
  { category: "gold", x: 136 },
  { category: "silver", x: 206 },
];

/**
 * "System Currencies" — a taller 2-row header (a 50×106 brand-blue money box +
 * the Group 16347 category strip over the "System Currencies 4 | 8" title), then
 * the rows. The category icons are FILTERS: click one to show only that
 * category (cash → USD/YTL/SYP/IQD/LBP, crypto → USDT, gold, silver); click it
 * again to show all. Each row's leading box holds the fiat code (14/Medium) or a
 * full-color icon; the card holds the name (14/Regular).
 *
 * With `editable` (RDB offers `currency.update`, `currencies:write` held) a
 * row opens the edit sheet on the end side (`CurrencyEditDrawer`); the
 * navbar's Close closes it. An inactive currency's row is dimmed.
 */
export function CurrencyList({
  items: initialItems,
  languages,
  editable,
}: {
  items: Currency[];
  /** The project's languages — the edit sheet's name rows. */
  languages: NameLanguage[];
  editable: boolean;
}) {
  const t = useTranslations("currency");
  const [active, setActive] = useState<CurrencyCategory | null>(null);
  // The list as RDB holds it; an edit RDB accepted updates its row here.
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? items.find((c) => c.id === selectedId) : undefined;

  // The sheet has no X of its own: while it is open, the navbar's Close closes it.
  const { setOnClose } = useAddAction();
  useEffect(() => {
    if (!selectedId) return;
    setOnClose(() => setSelectedId(null));
    return () => setOnClose(null);
  }, [selectedId, setOnClose]);

  const shown = active ? items.filter((c) => c.category === active) : items;

  return (
    <div className="flex h-full">
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      {/* Header — tall icon box + [category filter strip over title]. */}
      <header className="flex items-stretch gap-4 ps-12 pe-12">
        <span
          className="bg-surface hairline rad-12 text-ink flex h-106 w-50 shrink-0 items-center justify-center"
          style={
            {
              "--hairline-radius": "0.75rem",
              "--hairline-color": "#388cff",
            } as CSSProperties
          }
        >
          <Icon name="nav/currencies" size={26} mask />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-hidden">
          {/* Category filters (XD Group 16347) — icons at the strip start, each
              overlaid with a clickable button. */}
          <div className="relative h-50 w-full">
            <span
              aria-hidden
              className="bg-surface rad-12 absolute inset-0 bg-left bg-no-repeat"
              style={{
                backgroundImage: "url('/icons/currencies/categories.svg')",
                // Exact 1214×50 (XD px, rem) so the icons land at their designed
                // positions and the overlay filter buttons stay aligned.
                backgroundSize: `${rem(1214)} ${rem(50)}`,
              }}
            />
            {FILTERS.map((f) => (
              <button
                key={f.category}
                type="button"
                onClick={() =>
                  setActive((cur) => (cur === f.category ? null : f.category))
                }
                aria-label={t(`filter.${f.category}`)}
                aria-pressed={active === f.category}
                // Selected → a 50×50 brand-blue box framing the icon (XD image 10).
                className={cn(
                  "rad-12 absolute top-0 h-50 w-50",
                  active === f.category && "hairline",
                )}
                style={
                  {
                    insetInlineStart: rem(f.x),
                    "--hairline-radius": "0.75rem",
                    "--hairline-color": "#388cff",
                  } as CSSProperties
                }
              />
            ))}
          </div>
          {/* Title strip. */}
          <span className="bg-surface rad-12 flex h-50 items-center ps-12">
            <span className="fz-14 text-ink font-medium">
              {t("title")} 4 | {items.length}
            </span>
          </span>
        </div>
      </header>

      {shown.length === 0 ? (
        <p className="fz-14 text-ink mt-12 ps-12 font-light">{t("empty")}</p>
      ) : (
        <ul className="mt-12 flex flex-col gap-4 ps-12">
          {shown.map((item) => (
            <li
              key={item.id}
              className={cn("flex gap-4", item.isActive === false && "opacity-50")}
            >
              {/* Leading box — colorful icon if present, else the fiat code. */}
              <span className="bg-surface rad-12 fz-14 text-ink flex h-50 w-50 shrink-0 items-center justify-center font-medium">
                {item.icon ? (
                  <Icon name={item.icon} width={30} height={30} />
                ) : (
                  item.code
                )}
              </span>
              {/* Content card — the currency name; opens the edit sheet. */}
              {editable ? (
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={selectedId === item.id}
                  className={cn(
                    "bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12 text-start",
                    selectedId === item.id && "hairline",
                  )}
                  style={
                    {
                      "--hairline-radius": "0.75rem",
                      "--hairline-color": "#388cff",
                    } as CSSProperties
                  }
                >
                  <span className="fz-14 text-ink">{item.name}</span>
                </button>
              ) : (
                <div className="bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12">
                  <span className="fz-14 text-ink">{item.name}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>

      <AnimatePresence>
        {selected && (
          <CurrencyEditDrawer
            key={selected.id}
            currency={selected}
            languages={languages}
            onSaved={(next) => setItems((prev) => prev.map((c) => (c.id === next.id ? next : c)))}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

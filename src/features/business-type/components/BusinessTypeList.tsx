"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { iosEase } from "@/components/motion/presets";
import { useLocale, useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import type { NameLanguage } from "@/features/language/names";
import { pickRoleName } from "@/features/role/components/RolePanel";
import { closeAddUrl, useAddAction } from "@/features/shell/add-action";
import {
  BUSINESS_KINDS,
  type BusinessCountry,
  type BusinessKind,
  type BusinessType,
} from "../schema";
import { BusinessTypePanel } from "./BusinessTypePanel";

const BLUE = {
  "--hairline-radius": "0.75rem",
  "--hairline-color": "#388cff",
} as CSSProperties;

const TAB_ICON: Record<BusinessKind, string> = {
  individual: "business/individual",
  corporate: "business/corporate",
  work: "business/work-type",
};

/**
 * "System Business Type" (XD "Center Dash" 55–58) — the same frame as the
 * roles screen: a tall business-card box, the three kind tabs (Individual,
 * Corporate, Business Work Type) over the "System Business Type | {tab}"
 * strip, then the tab's types — a short-name chip and a 352-wide name card,
 * the selected one framed blue — and the selected type's panel on the end
 * side. The navbar "+" starts a new type of the open tab (`?add=business-type`).
 *
 * The rows are RDB's catalogs (`api.ts`); a save goes to RDB (`actions.ts`).
 */
export function BusinessTypeList({
  items: initial,
  countries,
  languages,
}: {
  items: BusinessType[];
  countries: BusinessCountry[];
  languages: NameLanguage[];
}) {
  const t = useTranslations("businessType");
  const locale = useLocale();
  const params = useSearchParams();
  const [items, setItems] = useState(initial);
  // The tab is client state, as on Regions and Roles; only "add" is in the URL.
  const [tab, setTab] = useState<BusinessKind>("individual");
  const shown = items.filter((i) => i.kind === tab);
  // Nothing open until a row (or the "+") is pressed.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const adding = params.get("add") === "business-type";
  const closeAdd = () => closeAddUrl("/business-types");
  const selected = adding
    ? null
    : (shown.find((i) => i.id === selectedId) ?? null);
  const panelOpen = adding || selected != null;

  const { setHref, setOnClose } = useAddAction();
  useEffect(() => {
    setHref("/business-types?add=business-type");
    return () => setHref(null);
  }, [setHref]);
  useEffect(() => {
    if (!panelOpen) return;
    setOnClose(() => (adding ? closeAdd() : setSelectedId(null)));
    return () => setOnClose(null);
  }, [panelOpen, adding, setOnClose]);

  function switchTab(next: BusinessKind) {
    if (adding) closeAdd();
    setTab(next);
    setSelectedId(null);
  }

  return (
    <div className="flex h-full gap-12">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex items-stretch gap-4 ps-12">
          <span
            className="hairline flex h-106 w-50 shrink-0 items-center justify-center rad-12 bg-surface"
            style={BLUE}
          >
            <Icon name="nav/business" size={26} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {/* Tabs: Individual, Corporate, Business Work Type — the open one framed blue. */}
            <div className="flex h-50 items-center gap-4 rad-12 bg-surface">
              {BUSINESS_KINDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => switchTab(id)}
                  aria-label={t(`tabs.${id}`)}
                  aria-pressed={tab === id}
                  style={tab === id ? BLUE : undefined}
                  className={cn(
                    "flex h-50 w-50 shrink-0 items-center justify-center rad-12 text-ink",
                    tab === id && "hairline",
                  )}
                >
                  <Icon name={TAB_ICON[id]} size={26} mask />
                </button>
              ))}
            </div>
            <span className="flex h-50 items-center rad-12 bg-surface ps-12">
              <span className="fz-14 font-light text-ink">
                {t("title")} |{" "}
                <span className="font-medium">{t(`tabs.${tab}`)}</span>
              </span>
            </span>
          </div>
        </header>

        {shown.length === 0 ? (
          <p className="mt-12 ps-12 fz-14 text-muted">{t("empty")}</p>
        ) : (
          <ul className="mt-12 flex flex-col gap-4 ps-12">
            {shown.map((item) => {
              const on = !adding && item.id === selectedId;
              return (
                <li key={item.id} className="flex gap-4">
                  <span className="flex h-50 w-50 shrink-0 items-center justify-center rad-12 bg-surface fz-14 text-ink">
                    {item.short_name}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (adding) closeAdd();
                      setSelectedId(item.id);
                    }}
                    aria-pressed={on}
                    style={on ? BLUE : undefined}
                    className={cn(
                      "flex h-50 w-352 max-w-full items-center rad-12 bg-surface ps-12 text-start",
                      on && "hairline",
                    )}
                  >
                    <span className="truncate fz-14 text-ink">
                      {pickRoleName(item.name, locale)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Slides in from the side and back out, as on Roles (the app's iOS curve). */}
      <AnimatePresence>
        {panelOpen && (
          <motion.aside
            initial={{ x: "100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0 }}
            transition={iosEase}
            className="flex h-full w-430 max-w-full shrink-0 flex-col"
            aria-label={
              selected ? pickRoleName(selected.name, locale) : t("newType")
            }
          >
            <BusinessTypePanel
              key={selected?.id ?? `new-${tab}`}
              type={selected}
              kind={tab}
              countries={countries}
              languages={languages}
              onSaved={(saved) => {
                setItems((list) =>
                  list.some((i) => i.id === saved.id)
                    ? list.map((i) => (i.id === saved.id ? saved : i))
                    : [...list, saved],
                );
                if (adding) closeAdd();
                setSelectedId(saved.id);
              }}
            />
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

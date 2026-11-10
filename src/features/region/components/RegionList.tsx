"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { useAddAction } from "@/features/shell/add-action";
import type { NameLanguage } from "@/features/language/names";
import type { Coded } from "../mock-ai";
import type { Division } from "../schema";
import {
  addChildById,
  removeById,
  updateById,
  findPathById,
  flagEmoji,
  countryMap,
  resolveFlag,
  type GeoNode,
} from "../mock-geo";
import {
  AddCountryDrawer,
  type CountryPreview,
  type NewChild,
  type NewCountry,
  type SavedChild,
} from "./AddCountryDrawer";
import { AddDivisionDrawer, type NewDivision } from "./AddDivisionDrawer";
import { CountryDetailDrawer } from "./CountryDetailDrawer";
import { CountryTree } from "./CountryTree";
import { GeoThumb } from "./GeoThumb";

type Tab = "countries" | "admin";
const TABS: { id: Tab; icon: string }[] = [
  { id: "countries", icon: "regions/flag" },
  { id: "admin", icon: "regions/map" },
];

/**
 * "System Geographic Regions" — 2-row header (globe box + Countries /
 * Administrative Divisions tabs over the title), then the country list or the
 * empty state. The navbar "+" opens the right-side Add-Country drawer via the
 * ?add=country param.
 *
 * Seeded from the selected system (`loadGeography`); every save goes to RDB
 * first (the drawers call the Server Actions) and is appended here only once
 * RDB has answered with its id — so the tree never shows something RDB does
 * not hold, and a reload shows the same tree.
 */
export function RegionList({
  countries: initialCountries,
  divisions: initialDivisions,
  languages,
  languageOptions,
  currencyOptions,
  flagUploads,
  reopenable,
}: {
  countries: GeoNode[];
  divisions: Division[];
  /** The project's languages (`language.list`) — a name's translation rows. */
  languages: NameLanguage[];
  /** The system's languages (a country's main language) and currencies — what those are picked from. */
  languageOptions: Coded[];
  currencyOptions: Coded[];
  /** RDB takes flag uploads (`media.upload` deployed, `media:write` held). */
  flagUploads: boolean;
  /** RDB offers `country.reopen`. */
  reopenable: boolean;
}) {
  const t = useTranslations("region");
  const router = useRouter();
  const params = useSearchParams();
  // The sub-tab is client state (kept out of the URL). Only the drawer uses a
  // param (?add=country | ?add=division), which the navbar "+" sets from the
  // add-action context below.
  const [tab, setTab] = useState<Tab>("countries");
  // The expandable geo tree, as RDB holds it; the drawers append to it.
  const [countries, setCountries] = useState<GeoNode[]>(initialCountries);
  // The region types (Administrative Divisions), as RDB holds them.
  const [divisions, setDivisions] = useState<NewDivision[]>(initialDivisions);
  // Live mirror of the Add-Country form (country + its levels) shown in this
  // column while the user types in the drawer.
  const [preview, setPreview] = useState<CountryPreview | null>(null);
  // The tree node whose detail sheet is open (id only — the node itself is
  // re-derived from state so added children show up immediately).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The tree's expanded chain — owned here so adding a value auto-reveals it.
  const [treePath, setTreePath] = useState<string[]>([]);
  // A sub-level being typed in the wizard — merged into the tree live so the
  // row appears/updates under its parent as you type, before saving.
  const [draftChild, setDraftChild] = useState<{
    parentId: string;
    child: NewChild;
  } | null>(null);

  const drawerOpen = params.get("add") != null;
  const closeDrawer = () => router.replace("/regions");
  const selectedPath = selectedId ? findPathById(countries, selectedId) : null;
  const openDetail = (id: string) => {
    setSelectedId(id);
    if (drawerOpen) closeDrawer();
  };

  // Shared by every "a value was added/is being typed under `parentId`" path
  // — recomputes its chain from current state and expands the tree to it
  // (optionally one level further, to the just-created node itself).
  const expandBranch = useCallback(
    (parentId: string, extraId?: string) => {
      const chain = findPathById(countries, parentId);
      if (!chain) return;
      setTreePath(extraId ? [...chain.map((n) => n.id), extraId] : chain.map((n) => n.id));
    },
    [countries],
  );

  // A GeoNode for a child just saved under `parentId`, with the map its form matched.
  const buildChildNode = (child: SavedChild): GeoNode => ({
    id: child.id,
    code: child.code,
    plate: child.plate,
    name: child.name,
    map: child.map,
    names: child.names,
    regionType: child.regionType,
    children: [],
  });

  // Tell the navbar "+" which drawer to open for the current tab; unregister
  // on unmount so the "+" goes inert on pages without an add modal.
  const { setHref, setOnClose } = useAddAction();
  useEffect(() => {
    setHref(tab === "admin" ? "/regions?add=division" : "/regions?add=country");
    return () => setHref(null);
  }, [tab, setHref]);

  // The detail drawer has no in-drawer X — while a node is selected, the
  // navbar's left "Close" control closes it instead.
  useEffect(() => {
    if (!selectedId) return;
    setOnClose(() => setSelectedId(null));
    return () => setOnClose(null);
  }, [selectedId, setOnClose]);
  // Save a country — appends it and RETURNS the node so the wizard can keep
  // the drawer open and drill into its levels. Does NOT close the drawer.
  const handleSaveCountry = (c: NewCountry): GeoNode => {
    const node: GeoNode = {
      id: c.id,
      code: c.code,
      name: c.name,
      // A code that matches a known country (TR, IQ, LB, SY, …) gets the
      // SAME real flag bitmap a statically-seeded row uses — only an
      // unrecognized code falls back to the emoji glyph (CountryTree).
      flag: resolveFlag(c.code),
      details: c.details,
      // A picked map wins over the generated one (until refresh — map-file.ts).
      map: c.map ?? countryMap(c.code),
      names: c.names,
      children: [],
    };
    setCountries((prev) => [...prev, node]);
    setPreview(null);
    return node;
  };
  // Add a sub-level under a node — appends, auto-expands the branch, returns
  // the created node so the wizard can drill one level deeper.
  const handleAddChild = (parentId: string, child: SavedChild): GeoNode => {
    const node = buildChildNode(child);
    setCountries((prev) => addChildById(prev, parentId, node));
    expandBranch(parentId, node.id);
    setDraftChild(null);
    return node;
  };
  // Live draft child from the wizard (stable identity for the drawer effect).
  // Also keeps the draft's branch expanded so it stays visible while typing.
  const handleDraftChild = useCallback(
    (parentId: string | null, child: NewChild | null) => {
      setDraftChild(parentId && child ? { parentId, child } : null);
      if (parentId && child) expandBranch(parentId);
    },
    [expandBranch],
  );
  const handleSaveDivision = (d: NewDivision) => {
    setDivisions((prev) => [...prev, d]);
    closeDrawer();
  };

  // The tree as displayed: the real countries plus the live draft child (if any)
  // merged under its parent so it shows/updates while typing.
  const displayCountries: GeoNode[] = draftChild
    ? addChildById(countries, draftChild.parentId, {
        id: "__draft__",
        code: draftChild.child.code,
        plate: draftChild.child.plate,
        name: draftChild.child.name,
        map: draftChild.child.map,
        children: [],
      })
    : countries;

  const showEmpty =
    tab === "countries"
      ? countries.length === 0 && !preview
      : divisions.length === 0;
  // The map the draft country previews with — the same one save assigns, so
  // the row is identical before and after saving.
  const draftMap = preview ? (preview.map ?? countryMap(preview.code)) : undefined;

  return (
    <div className="flex h-full">
      {/* Left: header + list (scrolls independently of the drawer). */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-stretch gap-4 ps-12 pe-12">
        {/* Tall globe box. */}
        <span
          className="bg-surface hairline rad-12 flex h-106 w-50 shrink-0 items-center justify-center"
          style={
            {
              "--hairline-radius": "0.75rem",
              "--hairline-color": "#388cff",
            } as CSSProperties
          }
        >
          <Icon name="regions/globe" size={26} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {/* Sub-tab strip — selected tab gets a blue 50×50 box. */}
          <div className="bg-surface rad-12 flex h-50 items-center gap-4">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => {
                  // Switching sub-tabs must not leave the OTHER tab's modal
                  // open behind it — close whichever is open (URL-param add
                  // drawer or the client-state detail sheet) first.
                  if (drawerOpen) closeDrawer();
                  setSelectedId(null);
                  setTab(tb.id);
                }}
                aria-label={t(`tabs.${tb.id}`)}
                aria-pressed={tab === tb.id}
                className={cn(
                  "rad-12 flex h-50 w-50 shrink-0 items-center justify-center",
                  tab === tb.id && "hairline",
                )}
                style={
                  tab === tb.id
                    ? ({
                        "--hairline-radius": "0.75rem",
                        "--hairline-color": "#388cff",
                      } as CSSProperties)
                    : undefined
                }
              >
                <Icon name={tb.icon} size={26} />
              </button>
            ))}
          </div>

          {/* Title strip — "System Geographic Regions | {tab}". */}
          <span className="bg-surface rad-12 flex h-50 items-center ps-12">
            <span className="fz-14 text-ink font-light">
              {t("title")} | <span className="font-medium">{t(`tabs.${tab}`)}</span>
            </span>
          </span>
        </div>
      </header>

      {showEmpty ? (
        // Empty state (XD Group 16369) — per-tab icon + message, gray, centered.
        <div
          className="flex flex-1 flex-col items-center justify-center gap-16"
          style={{ color: "#8d8d8d" }}
        >
          <Icon
            name={tab === "countries" ? "regions/flag" : "regions/map"}
            width={20}
            height={20}
            mask
          />
          <span className="fz-14">
            {tab === "countries" ? t("empty") : t("emptyAdmin")}
          </span>
        </div>
      ) : tab === "countries" ? (
        <>
          <CountryTree
            countries={displayCountries}
            path={treePath}
            onPathChange={setTreePath}
            onSelectNode={openDetail}
          />
          {/* Draft country, mirrored live from the drawer — just the country
              row (same markup a saved node gets, CountryTree GeoRow depth 0,
              with the map SVG save will assign at this index, so nothing
              changes visually on save). The division LEVELS being picked in
              the wizard are level TYPES (Province/District/…), not places —
              they never appear here; only actually-added children do, the
              same as any statically-added country. */}
          {preview && (
            <div className="mt-4 flex flex-col gap-4 ps-12">
              <div className="flex items-center gap-4">
                <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                  {(() => {
                    const flag = resolveFlag(preview.code);
                    return flag ? (
                      <Icon name={flag.icon} width={flag.w} height={flag.h} />
                    ) : (
                      <span className="fz-24 leading-none">{flagEmoji(preview.code)}</span>
                    );
                  })()}
                </span>
                <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                  {preview.code}
                </span>
                <span className="bg-surface rad-12 grid h-50 w-110 shrink-0 place-items-center">
                  {draftMap && <GeoThumb image={draftMap} />}
                </span>
                <span className="bg-surface rad-12 flex h-50 w-200 items-center px-12">
                  <span className="fz-14 text-ink truncate">{preview.name}</span>
                </span>
              </div>
            </div>
          )}
        </>
      ) : (
        <ul className="mt-12 flex flex-col gap-4 ps-12">
          {divisions.map((d) => (
            <li key={`${d.code}-${d.name}`} className="flex items-center gap-4">
              <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                {d.code}
              </span>
              <span className="bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12">
                <span className="fz-14 text-ink">{d.name}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      </div>

      {/* Right: the add drawer for the current tab, or a node's detail sheet. */}
      {tab === "countries" ? (
        <>
          <AddCountryDrawer
            open={drawerOpen}
            onClose={closeDrawer}
            onSaveCountry={handleSaveCountry}
            onAddChild={handleAddChild}
            onPreview={setPreview}
            onDraftChild={handleDraftChild}
            divisions={divisions}
            languages={languages}
            languageOptions={languageOptions}
            currencyOptions={currencyOptions}
            flagUploads={flagUploads}
          />
          <CountryDetailDrawer
            path={drawerOpen ? null : selectedPath}
            onDraftChild={handleDraftChild}
            languages={languages}
            languageOptions={languageOptions}
            currencyOptions={currencyOptions}
            divisions={divisions}
            flagUploads={flagUploads}
            reopenable={reopenable}
            onUpdateNode={(id, patch) =>
              setCountries((prev) => updateById(prev, id, patch))
            }
            onCloseNode={(id) => {
              // Closed in RDB. A country stays, greyed and read-only, its sheet
              // open on Reopen; a region leaves the tree (only open ones are listed).
              if (countries.some((c) => c.id === id)) {
                setCountries((prev) => updateById(prev, id, { closed: true }));
                return;
              }
              setCountries((prev) => removeById(prev, id));
              setTreePath((p) => (p.includes(id) ? p.slice(0, p.indexOf(id)) : p));
              setSelectedId(null);
            }}
            onAddChild={(parentId, child) => {
              setCountries((prev) => addChildById(prev, parentId, child));
              expandBranch(parentId);
              // Drill INTO the just-added child — same chaining as the
              // add-country wizard (save Province → immediately offer
              // District under THAT province, not another Province).
              setSelectedId(child.id);
            }}
          />
        </>
      ) : (
        <AddDivisionDrawer
          open={drawerOpen}
          onClose={closeDrawer}
          onSave={handleSaveDivision}
          languages={languages}
        />
      )}
    </div>
  );
}

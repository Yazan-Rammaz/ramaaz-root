"use client";

import { useEffect, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useAddAction } from "@/features/shell/add-action";
import { cn } from "@/lib/utils/cn";
import { selectSystem } from "../actions";
import type { System } from "../schema";
import { AddProjectDrawer } from "./AddProjectDrawer";

const SELECTED_OUTLINE = {
  "--hairline-radius": "0.75rem",
  "--hairline-color": "#388cff",
} as CSSProperties;

/** The URL that opens each drawer step — the navbar "+" turns into an X while one is open. */
export const ADD_HREF = "/systems?add=project";
export const connectHref = (id: string) =>
  `/systems?add=connect&id=${encodeURIComponent(id)}`;

/**
 * "System Projects" — exact from the XD export (Center Dash – 24.svg): the
 * shared SectionHeader (rocket icon), then a narrow column of rows, each a
 * 50×93 icon slot + a 352×93 #fcfcfc card. All text is ink (#1d1d1d) Quicksand;
 * the "light" category line is weight 300, not a gray color.
 *
 * Only a card the backend calls `selectable` (ACTIVE + CONNECTED) can be
 * selected: clicking it is a submit (Server Action → httpOnly cookie). Any
 * other card is greyed out with its state in the corner; one that isn't
 * connected yet opens the connect step instead, because connecting can happen
 * days after creating (the project team installs the verifier in between).
 *
 * The navbar "+" opens the add drawer (`?add=project`); see AddProjectDrawer.
 */
export function SystemList({
  items,
  selectedId,
  savedBaseUrl,
}: {
  items: System[];
  selectedId: string | null;
  /** The base URL the last connect saved, for the open connect step. */
  savedBaseUrl?: string;
}) {
  const t = useTranslations("system");
  const router = useRouter();
  const params = useSearchParams();
  const step = params.get("add");
  const connecting = step === "connect" ? items.find((s) => s.id === params.get("id")) : undefined;

  // Tell the navbar "+" what to open; unregister on unmount.
  const { setHref } = useAddAction();
  useEffect(() => {
    setHref(ADD_HREF);
    return () => setHref(null);
  }, [setHref]);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <SectionHeader icon="nav/rocket" title={t("title")} count={items.length} />

        {items.length === 0 ? (
          <p className="fz-14 text-ink mt-12 ps-12 font-light">{t("empty")}</p>
        ) : (
          <ul className="mt-12 flex flex-col gap-4 ps-12">
            {items.map((item) => (
              <li key={item.id} className="flex gap-4">
                {/* Leading slot — full row height, empty until logos are exported. */}
                <span aria-hidden className="bg-surface rad-12 h-93 w-50 shrink-0" />
                {/* Only a selectable project counts as selected, whatever the cookie
                    says: an older cookie can name one that has since failed. */}
                <Card item={item} selected={item.id === selectedId && item.selectable} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddProjectDrawer
        step={step === "project" ? "create" : connecting ? "connect" : null}
        project={connecting}
        savedBaseUrl={savedBaseUrl}
        onCreated={(project) => router.replace(connectHref(project.id))}
      />
    </div>
  );
}

function Card({ item, selected }: { item: System; selected: boolean }) {
  const t = useTranslations("system");
  const className = cn(
    "bg-surface rad-12 relative flex h-93 w-352 max-w-full flex-col justify-center ps-12 text-start",
    item.selectable ? "cursor-pointer" : "opacity-60",
    selected && "hairline",
  );
  const lines = (
    <>
      <span className="fz-16 text-ink font-medium leading-normal">{item.code}</span>
      <span className="fz-14 text-ink leading-normal">{item.name}</span>
      <span className="fz-12 text-ink font-light leading-normal">{item.description}</span>
      {!item.selectable && (
        <span
          className={cn(
            "fz-10 absolute end-12 top-12",
            item.connectionStatus === "FAILED" ? "text-red-500" : "text-muted",
          )}
        >
          {t(`status.${statusKey(item)}`)}
        </span>
      )}
    </>
  );

  // Selectable (ACTIVE + CONNECTED) → submit selects it for the whole dashboard.
  if (item.selectable) {
    return (
      <form action={selectSystem.bind(null, item.id)} className="contents">
        <button
          type="submit"
          aria-pressed={selected}
          className={className}
          style={selected ? SELECTED_OUTLINE : undefined}
        >
          {lines}
        </button>
      </form>
    );
  }

  // Suspended → nothing to do here. Not connected yet → finish connecting.
  if (item.status === "SUSPENDED") return <div className={className}>{lines}</div>;
  return (
    <Link href={connectHref(item.id)} className={className}>
      {lines}
    </Link>
  );
}

/** Why a card isn't selectable, as a `system.status` key. */
function statusKey(item: System): "suspended" | "failed" | "notConnected" | "unavailable" {
  if (item.status === "SUSPENDED") return "suspended";
  if (item.connectionStatus === "FAILED") return "failed";
  if (item.connectionStatus !== "CONNECTED") return "notConnected";
  return "unavailable";
}

import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { selectSystem } from "../actions";
import type { System } from "../schema";

const SELECTED_OUTLINE = {
  "--hairline-radius": "0.75rem",
  "--hairline-color": "#388cff",
} as CSSProperties;

/**
 * "System Projects" — exact from the XD export (Center Dash – 24.svg): the
 * shared SectionHeader (rocket icon), then a narrow column of rows, each a
 * 50×93 icon slot + a 352×93 #fcfcfc card. All text is ink (#1d1d1d) Quicksand;
 * the "light" category line is weight 300, not a gray color.
 *
 * Each card is a submit button: clicking a system SELECTS it (Server Action →
 * httpOnly cookie) and the project pages (regions, currencies, …) start
 * talking to that system's own backend. The selected card gets the brand-blue
 * hairline the navbar uses for its active box.
 */
export async function SystemList({
  items,
  selectedId,
}: {
  items: System[];
  selectedId: string | null;
}) {
  const t = await getTranslations("system");

  return (
    <div className="flex flex-col">
      <SectionHeader icon="nav/rocket" title={t("title")} count={items.length} />

      {items.length === 0 ? (
        <p className="fz-14 text-ink mt-12 ps-12 font-light">{t("empty")}</p>
      ) : (
        <ul className="mt-12 flex flex-col gap-4 ps-12">
          {items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <li key={item.id} className="flex gap-4">
                {/* Leading slot — full row height, empty until logos are exported. */}
                <span
                  aria-hidden
                  className="bg-surface rad-12 h-93 w-50 shrink-0"
                />
                {/* Content card — 352 XD px wide, borderless #fcfcfc fill;
                    submit selects this system for the whole dashboard. */}
                <form action={selectSystem.bind(null, item.id)} className="contents">
                  <button
                    type="submit"
                    aria-pressed={selected}
                    className={`bg-surface rad-12 flex h-93 w-352 max-w-full cursor-pointer flex-col justify-center ps-12 text-start${selected ? " hairline" : ""}`}
                    style={selected ? SELECTED_OUTLINE : undefined}
                  >
                    <span className="fz-16 text-ink font-medium leading-normal">
                      {item.code}
                    </span>
                    <span className="fz-14 text-ink leading-normal">
                      {item.name}
                    </span>
                    <span className="fz-12 text-ink font-light leading-normal">
                      {item.description}
                    </span>
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

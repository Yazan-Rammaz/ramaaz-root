import { getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { Language } from "../schema";

/**
 * "System Languages" — exact from the XD export (system-languages/*.svg): the
 * shared SectionHeader (translate icon, brand-blue #388cff outline), then a
 * column of 50-tall rows. Each row is a 50×50 slot holding a 26×26 black
 * (#1d1d1d, radius 5) code chip with the code in white, next to a 352×50
 * #fcfcfc card with the language name (14px Quicksand, ink).
 */
export async function LanguageList({ items }: { items: Language[] }) {
  const t = await getTranslations("language");

  return (
    <div className="flex flex-col">
      <SectionHeader
        icon="nav/translate"
        title={t("title")}
        count={items.length}
        borderColor="#388cff"
      />

      {items.length === 0 ? (
        <p className="fz-14 text-ink mt-12 ps-12 font-light">{t("empty")}</p>
      ) : (
        <ul className="mt-12 flex flex-col gap-4 ps-12">
          {items.map((item) => (
            <li key={item.id} className="flex gap-4">
              {/* Leading slot — holds the black code chip, centered. */}
              <span className="bg-surface rad-12 flex h-50 w-50 shrink-0 items-center justify-center">
                <span className="bg-ink rad-5 fz-12 flex h-26 w-26 items-center justify-center font-semibold text-white">
                  {item.code}
                </span>
              </span>
              {/* Content card — 352 XD px wide, borderless #fcfcfc fill. */}
              <div className="bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12">
                <span className="fz-14 text-ink">{item.name}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { readPickedMap, type MapProblem } from "../map-file";
import type { GeoImage } from "../mock-geo";
import { GeoThumb } from "./GeoThumb";

/**
 * The map box of the country form — always a file picker (SVG only). It
 * shows the map the person picked, else the generated one for the code
 * (`countryMap`), else the empty "+ SVG Map" box. A picked map lives on the
 * screen only — see `map-file.ts`.
 */
export function MapPicker({
  generated,
  picked,
  problem,
  onPick,
}: {
  generated?: GeoImage;
  picked: GeoImage | null;
  problem: MapProblem | null;
  onPick: (result: GeoImage | MapProblem) => void;
}) {
  const t = useTranslations("region.map");
  const map = picked ?? generated;

  return (
    <span className="flex shrink-0 flex-col gap-4">
      <label
        className="flex h-50 w-64 shrink-0 cursor-pointer flex-col items-center justify-center gap-2 rad-12 bg-surface fz-10 text-muted"
        title={t("pick")}
      >
        {map ? (
          // Fitted to the 64 × 50 box (56 × 42 inside its padding).
          <GeoThumb image={map} scale={Math.min(1, 56 / map.w, 42 / map.h)} />
        ) : (
          <>
            <span className="fz-14 leading-none">+</span>
            {t("label")}
          </>
        )}
        <input
          type="file"
          accept="image/svg+xml"
          className="sr-only"
          aria-label={t("pick")}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            // Cleared so picking the same file again still fires.
            e.target.value = "";
            if (file) onPick(await readPickedMap(file));
          }}
        />
      </label>
      {problem && (
        <span className="w-64 fz-10 text-red-500">
          {t(`problem.${problem}`)}
        </span>
      )}
    </span>
  );
}

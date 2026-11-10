"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { readPickedFlag, type FlagProblem, type PickedFlag } from "../flag-file";
import { resolveFlag } from "../mock-geo";
import { FLAG_TYPES } from "../schema";

/**
 * The flag box of the country forms. It shows, in order: the file the person
 * picked, our bundled flag for the code, or the empty "+ Flag" box.
 *
 * With `enabled` (RDB offers `media.upload` and the person holds
 * `media:write`) the box is also a file picker — SVG, PNG or WebP up to
 * 256 KB, checked here before anything is sent. Without it the box only
 * shows the bundled flag, as before uploads existed.
 */
export function FlagPicker({
  code,
  enabled,
  picked,
  problem,
  onPick,
}: {
  code: string;
  enabled: boolean;
  picked: PickedFlag | null;
  problem: FlagProblem | null;
  onPick: (result: PickedFlag | FlagProblem) => void;
}) {
  const t = useTranslations("region.flag");
  const bundled = resolveFlag(code);

  const face = picked ? (
    // eslint-disable-next-line @next/next/no-img-element -- data URL of the picked file
    <img src={picked.preview} alt="" className="h-26 w-auto max-w-56 object-contain" />
  ) : bundled ? (
    <Icon name={bundled.icon} width={bundled.w} height={bundled.h} />
  ) : (
    <>
      <span className="fz-14 leading-none">+</span>
      {t("label")}
    </>
  );

  const box = cn(
    "bg-surface rad-12 fz-10 text-muted flex h-50 w-64 shrink-0 flex-col items-center justify-center gap-2",
    enabled && "cursor-pointer",
  );

  return (
    <span className="flex shrink-0 flex-col gap-4">
      {enabled ? (
        <label className={box} title={t("pick")}>
          {face}
          <input
            type="file"
            accept={FLAG_TYPES.join(",")}
            className="sr-only"
            aria-label={t("pick")}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              // Cleared so picking the same file again still fires.
              e.target.value = "";
              if (file) onPick(await readPickedFlag(file));
            }}
          />
        </label>
      ) : (
        <span className={box}>{face}</span>
      )}
      {problem && <span className="fz-10 w-64 text-red-500">{t(`problem.${problem}`)}</span>}
    </span>
  );
}

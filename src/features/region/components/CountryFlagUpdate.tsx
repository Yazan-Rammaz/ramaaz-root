"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/ui/FormError";
import { updateCountryFlagAction } from "../actions";
import { readBundledFlag, type FlagProblem, type PickedFlag } from "../flag-file";
import { useWrite } from "../use-write";
import { FlagPicker } from "./FlagPicker";

/**
 * A saved country's flag, moved onto RDB: pick a file (or keep our bundled one
 * for the code) and upload it, then `country.update` sets it (answers
 * 2026-10-31 §1). This is also how the countries created with a flagcdn link
 * get an RDB-hosted flag once `media.upload` is deployed — RDB's apps should
 * load no image from a third-party site.
 *
 * Shown only when uploads are on; the tree keeps showing the bundled flag by
 * code either way (RDB's link is on another host, which the CSP does not
 * load images from).
 */
export function CountryFlagUpdate({
  countryId,
  code,
  onUpdated,
}: {
  countryId: string;
  code: string;
  /** The country's new `updatedAt` — its next edit must send that one back. */
  onUpdated: (updatedAt: string | undefined) => void;
}) {
  const t = useTranslations("region.flag");
  const write = useWrite();
  const [picked, setPicked] = useState<PickedFlag | null>(null);
  const [problem, setProblem] = useState<FlagProblem | null>(null);
  const [done, setDone] = useState(false);

  async function upload() {
    const f = picked ?? (await readBundledFlag(code));
    if (!f) {
      setProblem("missing");
      return;
    }
    const ok = await write.runOk((resume) => updateCountryFlagAction(countryId, f.file, resume));
    if (ok) {
      onUpdated(ok.updatedAt);
      write.reset(true);
      setDone(true);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-8">
        <FlagPicker
          code={code}
          enabled
          picked={picked}
          problem={problem}
          onPick={(r) => {
            if (typeof r === "string") {
              setProblem(r);
              return;
            }
            setPicked(r);
            setProblem(null);
            setDone(false);
            write.reset(true);
          }}
        />
        <button
          type="button"
          onClick={upload}
          disabled={write.busy}
          aria-busy={write.busy}
          className="bg-ink fz-12 rad-12 h-50 flex-1 px-12 font-medium text-white disabled:opacity-50"
        >
          {write.busy ? t("uploading") : done ? t("uploaded") : t("upload")}
        </button>
      </div>
      <FormError message={write.message} attempt={write.attempt} />
    </div>
  );
}

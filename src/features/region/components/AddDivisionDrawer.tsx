"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AnimatePresence, motion } from "motion/react";
import { iosEase } from "@/components/motion/presets";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { FormError } from "@/components/ui/FormError";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { createDivisionAction } from "../actions";
import { translateNameAction } from "../ai";
import type { DivisionDraft } from "../mock-division";
import { divisionChip, divisionKey, type Division } from "../schema";
import { useWrite } from "../use-write";
import { requiredFilled, type NameLanguage } from "@/features/language/names";
import { emptyTranslations, Field, newName, Section, type Phase } from "./AddCountryDrawer";
import { NameRows } from "./NameRows";
import { useAutoNames } from "../use-auto-names";
import type { NameRow } from "@/features/language/names";

/** A region type RDB has just created. */
export type NewDivision = Division;

/**
 * "Add Administrative Divisions" drawer (XD add-new-admin-division 1–2). Same
 * shell/animations as Add Country but a simpler form: short name + a division
 * name (typed or picked from the type dropdown), then an AI-generated name
 * translation across the system languages, and Add & Save.
 */
export function AddDivisionDrawer({
  open,
  onSave,
  languages,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (d: NewDivision) => void;
  /** The project's languages; English is the typed name, the rest are rows. */
  languages: NameLanguage[];
}) {
  return (
    <AnimatePresence>{open && <Body onSave={onSave} languages={languages} />}</AnimatePresence>
  );
}

function Body({ onSave, languages }: { onSave: (d: NewDivision) => void; languages: NameLanguage[] }) {
  const [shortName, setShortName] = useState("");
  const [name, setName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<DivisionDraft | null>(null);
  const timer = useRef<number>(0);
  // Each AI request's ticket: a late answer for an older name is dropped.
  const genSeq = useRef(0);
  const write = useWrite();

  // The key is permanent and comes from the name ("Sub district" → sub_district);
  // the chip is derived from it, as for every type RDB lists.
  const key = divisionKey(name);
  async function save() {
    const saved = await write.run((resume) =>
      createDivisionAction(
        { key, name: newName(languages, draft?.translations, name) },
        resume,
      ),
    );
    if (saved) onSave({ key, code: divisionChip(key), name: name.trim() });
  }

  function schedule(sn: string, nm: string) {
    window.clearTimeout(timer.current);
    genSeq.current++;
    write.reset();
    if (!sn.trim() || !nm.trim()) {
      setGenerating(false);
      setDraft(null);
      return;
    }
    setGenerating(true);
    setDraft(null);
    timer.current = window.setTimeout(() => {
      const ticket = ++genSeq.current;
      translateNameAction(nm.trim(), "a type of administrative division of a country (like province or district)")
        .catch(() => emptyTranslations(languages, nm.trim()))
        .then((all) => {
          if (ticket !== genSeq.current) return;
          // English is the typed name itself; the rows are the other languages.
          setDraft({ shortName: sn.trim(), name: nm.trim(), translations: all.filter((t) => t.code !== "EN") });
          setGenerating(false);
        });
    }, 3000);
  }

  const phase: Phase = generating ? "gen" : draft ? "ready" : "idle";
    // "Re Translation": every row again from the English name. This drawer's
    // own AI pass fills the name as it is typed, so the hook is the button only.
    const setDraftRows: Dispatch<SetStateAction<NameRow[]>> = (u) =>
        setDraft((d) => d && { ...d, translations: typeof u === "function" ? u(d.translations) : u });
    const auto = useAutoNames({
        en: name.trim(),
        rows: draft?.translations ?? [],
        setRows: setDraftRows,
        ask: async (text) => ({ translations: await translateNameAction(text, "a type of administrative division of a country (like province or district)") }),
        auto: false,
    });

  return (
    <motion.aside
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={iosEase}
      className="bg-background relative flex h-full w-430 max-w-full shrink-0 flex-col"
      aria-label="Add division"
    >
      <DashedFrame radius={20} color="#8d8d8d" />

      <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
        <span className="fz-16 text-ink flex items-center gap-8 font-medium">
          <Icon name="nav/add" size={18} mask />
          Add Administrative Divisions
        </span>

        <Section title="Add Divisions Name">
          <div className="flex gap-4">
            <Field
              className="w-132 shrink-0"
              label="Divisions Short Name"
              hint="Max 4/4"
              value={shortName}
              maxLength={4}
              onChange={(v) => {
                setShortName(v);
                schedule(v, name);
              }}
            />
            {/* Name — a plain text input (e.g. "Country"); AI translates it. */}
            <Field
              className="flex-1"
              label="Divisions Name"
              value={name}
              onChange={(v) => {
                setName(v);
                schedule(shortName, v);
              }}
            />
          </div>
        </Section>

        <Section
          title={'Divisions Name Translation "System Languages"'}
          onAi={draft ? auto.retranslate : undefined}
          phase={draft ? auto.phase : phase}
          ai
        >
          <NameRows
            languages={languages}
            rows={draft?.translations ?? null}
            phase={phase}
            filling={auto.filling}
                    onRetranslate={auto.retranslateOne}
            skip={["EN"]}
            errors={write.fields}
            onChange={(translations) => {
              setDraft((d) => d && { ...d, translations });
              write.reset();
            }}
          />
        </Section>
      </div>

      <AnimatePresence>
        {phase === "ready" && requiredFilled(languages, newName(languages, draft?.translations, name)) && (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            className="shrink-0 p-24 pt-0"
          >
            <button
              type="button"
              onClick={save}
              disabled={write.busy}
              aria-busy={write.busy}
              className={cn(
                "bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center gap-8 font-medium text-white disabled:opacity-50",
              )}
            >
              ↳ Add &amp; Save
            </button>
            <FormError message={write.message} attempt={write.attempt} className="mt-8" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

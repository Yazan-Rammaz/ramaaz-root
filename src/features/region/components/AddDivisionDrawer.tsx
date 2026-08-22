"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { iosEase } from "@/components/motion/presets";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import { generateDivision, type DivisionDraft } from "../mock-division";
import { ChipLine, Field, Section, type Phase } from "./AddCountryDrawer";

export type NewDivision = { code: string; name: string };

/**
 * "Add Administrative Divisions" drawer (XD add-new-admin-division 1–2). Same
 * shell/animations as Add Country but a simpler form: short name + a division
 * name (typed or picked from the type dropdown), then an AI-generated name
 * translation across the system languages, and Add & Save.
 */
export function AddDivisionDrawer({
  open,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (d: NewDivision) => void;
}) {
  return (
    <AnimatePresence>{open && <Body onSave={onSave} />}</AnimatePresence>
  );
}

function Body({ onSave }: { onSave: (d: NewDivision) => void }) {
  const [shortName, setShortName] = useState("");
  const [name, setName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<DivisionDraft | null>(null);
  const timer = useRef<number>(0);

  function schedule(sn: string, nm: string) {
    window.clearTimeout(timer.current);
    if (!sn.trim() || !nm.trim()) {
      setGenerating(false);
      setDraft(null);
      return;
    }
    setGenerating(true);
    setDraft(null);
    timer.current = window.setTimeout(() => {
      setDraft(generateDivision(sn.trim(), nm.trim()));
      setGenerating(false);
    }, 3000);
  }

  const phase: Phase = generating ? "gen" : draft ? "ready" : "idle";
  const code = shortName.trim().toUpperCase().slice(0, 4);

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

        <Section title={'Divisions Name Translation "System Languages"'} phase={phase} ai>
          {[0, 1, 2].map((i) => (
            <ChipLine
              key={i}
              phase={phase}
              code={draft?.translations[i]?.code}
              value={draft?.translations[i]?.name}
            />
          ))}
        </Section>
      </div>

      <AnimatePresence>
        {phase === "ready" && (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            className="shrink-0 p-24 pt-0"
          >
            <button
              type="button"
              onClick={() => onSave({ code, name: name.trim() })}
              className={cn(
                "bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center gap-8 font-medium text-white",
              )}
            >
              ↳ Add &amp; Save
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

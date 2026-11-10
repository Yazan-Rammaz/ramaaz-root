"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { NameRow } from "@/features/language/names";
import type { Translation } from "./mock-ai";
import { translationOf, type Phase } from "./components/AddCountryDrawer";

const NONE: ReadonlySet<string> = new Set();

/**
 * The AI's part in every form with a name in several languages.
 *
 * - **On open** it fills nothing: an empty language stays empty until asked.
 * - **After the English name changes** (a moment later) it fills the empty
 *   rows, and the rows it filled itself; anything typed by hand stays
 *   (`typed`).
 * - **`retranslate()`** — a click on the AI mark — redoes every row from the
 *   English name, typed ones included: that is what was asked for.
 * - **`retranslateOne(chip)`** — a click on a row's chip (AR, TR) — redoes
 *   that language only.
 *
 * `filling` is the rows the AI is working on right now: only those shimmer
 * (`NameRows`), the rest stay as they are. `auto: false` keeps just the
 * clicks, for a form whose own AI pass already fills the name (the Add
 * drawers). `needsAtOpen` asks on open for the rest of the answer only
 * (`onAnswer`: a country's main language) — no name row is touched.
 */
export function useAutoNames<A extends { translations: Translation[] }>({
  en,
  rows,
  setRows,
  needsAtOpen = false,
  ask,
  onAnswer,
  auto = true,
}: {
  en: string;
  rows: NameRow[];
  setRows: Dispatch<SetStateAction<NameRow[]>>;
  needsAtOpen?: boolean;
  ask: (en: string) => Promise<A>;
  onAnswer?: (answer: A) => void;
  auto?: boolean;
}) {
  const [filling, setFilling] = useState<ReadonlySet<string>>(NONE);
  const aiFilled = useRef(new Set<string>());
  const [openedWith] = useState(() => en.trim());
  const doneAtOpen = useRef(false);
  // The latest rows and callbacks, for a request that answers later.
  const latest = useRef({ rows, ask, onAnswer });
  useEffect(() => {
    latest.current = { rows, ask, onAnswer };
  });
  // Each request's ticket: an answer to an older one is dropped.
  const ticket = useRef(0);

  /** `which`: "missing" (empty or AI-filled rows), "all", "none" (just the answer), or one chip. */
  function run(text: string, which: "missing" | "all" | "none" | { chip: string }, force = false) {
    const targets =
      which === "none"
        ? []
        : latest.current.rows
            .filter(
              (r) =>
                r.code !== "EN" &&
                (typeof which === "object"
                  ? r.code === which.chip
                  : which === "all" || !r.name.trim() || aiFilled.current.has(r.code)),
            )
            .map((r) => r.code);
    if (!targets.length && !force) return;
    const mine = ++ticket.current;
    setFilling(new Set(targets));
    latest.current
      .ask(text)
      .then((answer) => {
        if (mine !== ticket.current) return;
        setRows((current) =>
          current.map((r) => {
            if (!targets.includes(r.code)) return r;
            const v = translationOf(answer.translations, r.code);
            if (!v) return r;
            aiFilled.current.add(r.code);
            return { ...r, name: v };
          }),
        );
        latest.current.onAnswer?.(answer);
      })
      .catch(() => {})
      .finally(() => {
        if (mine === ticket.current) setFilling(NONE);
      });
  }

  useEffect(() => {
    if (!auto) return;
    const text = en.trim();
    if (!text) return;
    const atOpen = text === openedWith;
    if (atOpen && doneAtOpen.current) return;
    const timer = window.setTimeout(
      () => {
        if (atOpen) doneAtOpen.current = true;
        if (atOpen) {
          // Opening touches no name row; only the rest of the answer is asked for.
          if (needsAtOpen) run(text, "none", true);
          return;
        }
        run(text, "missing");
      },
      atOpen ? 0 : 1500,
    );
    return () => window.clearTimeout(timer);
    // Keyed on the English name alone: the rest is read when the request goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [en]);

  /** Rows the person typed in are theirs from now on. */
  function typed(before: NameRow[], after: NameRow[]) {
    for (const r of after) {
      if (before.find((b) => b.code === r.code)?.name !== r.name) aiFilled.current.delete(r.code);
    }
  }

  return {
    filling,
    phase: (filling.size ? "gen" : "ready") as Phase,
    typed,
    /** Every row again from the English name — the AI mark. */
    retranslate: () => {
      if (en.trim()) run(en.trim(), "all");
    },
    /** One language again from the English name — its chip. */
    retranslateOne: (chip: string) => {
      if (en.trim()) run(en.trim(), { chip });
    },
  };
}

/** A row other than English with no text yet. */
export const hasEmptyRow = (rows: NameRow[]) => rows.some((r) => r.code !== "EN" && !r.name.trim());

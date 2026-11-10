"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useLockWhenLocked } from "@/features/auth/use-lock-when-locked";
import type { Resume, WriteResult } from "./write";

/**
 * One drawer button's write: busy while it runs, the line to show under it,
 * and — the part that matters — the `UNKNOWN` memory. When the last answer
 * was `pending`, the next press hands that command back to the action, which
 * retries it instead of sending a second one (rdb-screens §2.2). Anything the
 * person changes in the form should call `reset()`: a different request is a
 * new action, never a retry. What already went through is kept, though
 * (`carry`: a created country, an uploaded flag), so the next press does not
 * do it twice; `reset(true)` forgets that too — for a new flag file.
 */
export function useWrite() {
  const t = useTranslations("region.errors");
  const [state, setState] = useState<WriteResult>({});
  const [busy, setBusy] = useState(false);
  useLockWhenLocked(state);
  // Stable, so a form can call it from a callback it hands to an effect.
  const reset = useCallback(
    (all = false) => setState((s) => (all || !s.carry ? {} : { carry: s.carry })),
    [],
  );

  /**
   * The whole answer — for a form that also reacts to a refusal: a country
   * closed meanwhile (`closed`), or the record as it is now after
   * `409 STALE_UPDATE` (`fresh`). Null when a press was already running.
   */
  async function runResult(write: (resume?: Resume) => Promise<WriteResult>): Promise<WriteResult | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await write(state.pending ?? state.carry);
      setState(result);
      return result;
    } finally {
      setBusy(false);
    }
  }

  /** The whole success — an edit also answers the record's new `updatedAt`. */
  async function runOk(
    write: (resume?: Resume) => Promise<WriteResult>,
  ): Promise<NonNullable<WriteResult["ok"]> | null> {
    return (await runResult(write))?.ok ?? null;
  }

  /** Just the id RDB gave it. */
  async function run(write: (resume?: Resume) => Promise<WriteResult>): Promise<string | null> {
    return (await runOk(write))?.id ?? null;
  }

  return {
    run,
    runOk,
    runResult,
    /** RDB's per-field messages from the last answer (`name.fa` → that row). */
    fields: state.fields ?? {},
    busy,
    /** For `<FormError message attempt>`. */
    message: state.error ?? (state.pending ? t("pending") : undefined),
    attempt: state,
    reset,
  };
}

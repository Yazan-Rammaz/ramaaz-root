"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useLockWhenLocked } from "@/features/auth/use-lock-when-locked";
import type { WorkResult } from "./actions";

/**
 * One work-structure write: busy while it runs (one press at a time), the PIN
 * lock when the session wants it, and the last answer — its `error` for
 * `<FormError>`, its `fields` for the inputs, its `notice` for a passing line.
 * On `ok` (and on `reload`) the page is read again: a person's state is put
 * together on the server from several reads. `reset()` when an input changes.
 */
export function useWorkWrite() {
  const router = useRouter();
  const [result, setResult] = useState<WorkResult>({});
  const [busy, setBusy] = useState(false);
  useLockWhenLocked(result);
  const reset = useCallback(() => setResult({}), []);

  async function run(write: () => Promise<WorkResult>): Promise<WorkResult | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await write();
      setResult(r);
      if (r.ok || r.reload) router.refresh();
      return r;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, result, reset };
}

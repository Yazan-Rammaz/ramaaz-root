"use client";

import { useCallback, useState } from "react";
import { useLockWhenLocked } from "@/features/auth/use-lock-when-locked";
import type { RoleResult } from "./actions";

/**
 * One roles-screen write: busy while it runs (one press at a time), the PIN
 * lock when the session wants it, and the last answer — its `error` for
 * `<FormError>`, its `fields` for the inputs. `reset()` when an input changes:
 * a stored failure belongs to the attempt that produced it.
 */
export function useRoleWrite() {
  const [result, setResult] = useState<RoleResult>({});
  const [busy, setBusy] = useState(false);
  useLockWhenLocked(result);
  const reset = useCallback(() => setResult({}), []);

  async function run(write: () => Promise<RoleResult>): Promise<RoleResult | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await write();
      setResult(r);
      return r;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, result, reset };
}

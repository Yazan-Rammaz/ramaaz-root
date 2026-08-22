"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Lets a page tell the global navbar "+" what it should open, without putting UI
 * state (like the regions sub-tab) in the URL. A page that HAS an add modal
 * registers its href on mount (e.g. "/regions?add=country" vs "…?add=division")
 * and unregisters (null) on unmount. On pages that registered nothing, the "+"
 * is inert — visible but does nothing, until that page gets its own add modal.
 *
 * `onClose` is the same idea for the navbar's left "Close" control: a page
 * with a client-state sheet open (no URL param, e.g. a detail drawer) registers
 * a handler while it's open and clears it (null) once closed/unmounted. There
 * is never an in-drawer X — closing is always this one navbar control.
 */
type AddAction = {
  href: string | null;
  setHref: (h: string | null) => void;
  onClose: (() => void) | null;
  setOnClose: (fn: (() => void) | null) => void;
};

const AddActionContext = createContext<AddAction>({
  href: null,
  setHref: () => {},
  onClose: null,
  setOnClose: () => {},
});

export function AddActionProvider({ children }: { children: ReactNode }) {
  const [href, setHref] = useState<string | null>(null);
  const [onClose, setOnCloseState] = useState<(() => void) | null>(null);
  // useState setters treat a function argument as an updater, so wrap the
  // handler itself before storing it. Memoized: an unstable identity here
  // would re-trigger every effect that depends on it, which calls it again,
  // which re-renders the provider — an infinite loop.
  const setOnClose = useCallback(
    (fn: (() => void) | null) => setOnCloseState(() => fn ?? null),
    [],
  );
  const value = useMemo(
    () => ({ href, setHref, onClose, setOnClose }),
    [href, onClose, setOnClose],
  );
  return <AddActionContext.Provider value={value}>{children}</AddActionContext.Provider>;
}

export const useAddAction = () => useContext(AddActionContext);

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
 *
 * `hideAdd` takes the "+" away altogether — for a view of an add page that
 * has nothing to add (the read-only Permissions tab of /roles). The X for an
 * open sheet still shows.
 *
 * `hiddenAt` is the page the navbar's red X put away: its content goes, and
 * the section box shrinks to its icon until that box is pressed again. Kept
 * as the page's path, so moving to another page always shows it.
 */
type AddAction = {
  href: string | null;
  setHref: (h: string | null) => void;
  onClose: (() => void) | null;
  setOnClose: (fn: (() => void) | null) => void;
  hideAdd: boolean;
  setHideAdd: (hide: boolean) => void;
  hiddenAt: string | null;
  setHiddenAt: (path: string | null) => void;
};

const AddActionContext = createContext<AddAction>({
  href: null,
  setHref: () => {},
  onClose: null,
  setOnClose: () => {},
  hideAdd: false,
  setHideAdd: () => {},
  hiddenAt: null,
  setHiddenAt: () => {},
});

export function AddActionProvider({ children }: { children: ReactNode }) {
  const [href, setHref] = useState<string | null>(null);
  const [onClose, setOnCloseState] = useState<(() => void) | null>(null);
  const [hideAdd, setHideAdd] = useState(false);
  const [hiddenAt, setHiddenAt] = useState<string | null>(null);
  // useState setters treat a function argument as an updater, so wrap the
  // handler itself before storing it. Memoized: an unstable identity here
  // would re-trigger every effect that depends on it, which calls it again,
  // which re-renders the provider — an infinite loop.
  const setOnClose = useCallback(
    (fn: (() => void) | null) => setOnCloseState(() => fn ?? null),
    [],
  );
  const value = useMemo(
    () => ({ href, setHref, onClose, setOnClose, hideAdd, setHideAdd, hiddenAt, setHiddenAt }),
    [href, onClose, setOnClose, hideAdd, hiddenAt],
  );
  return <AddActionContext.Provider value={value}>{children}</AddActionContext.Provider>;
}

export const useAddAction = () => useContext(AddActionContext);

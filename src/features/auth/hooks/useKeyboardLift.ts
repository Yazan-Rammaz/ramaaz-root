import { useEffect, type RefObject } from 'react';

/** Room kept under the field above the keyboard — the line under it (an error, "Forgot passcode"). */
const KEYBOARD_GAP = 64;

/**
 * Above the keyboard (2026-11-24). On an iPhone the keyboard and its toolbar
 * (arrows, ✓ — iOS's own, a page cannot remove it) slide OVER the page without
 * resizing it, and covered the field. While `active` (the field has focus), the
 * screen — the nearest `data-keyboard-lift`, else <main> — is moved up just
 * enough that the field and the line under it sit above what is still visible
 * (visualViewport), and back down when the keyboard goes. Never so far that the
 * field leaves the top. `translate`, not `transform`: the screens animate their
 * own transform with Motion. Used by the passcode boxes and the private code.
 */
export function useKeyboardLift(ref: RefObject<HTMLElement | null>, active: boolean): void {
    useEffect(() => {
        const vv = typeof window === 'undefined' ? null : window.visualViewport;
        const root = ref.current;
        if (!active || !vv || !root) return;
        const target =
            (root.closest('[data-keyboard-lift]') as HTMLElement | null) ??
            (root.closest('main') as HTMLElement | null) ??
            root;
        const rect = root.getBoundingClientRect();
        const place = () => {
            const visible = vv.offsetTop + vv.height;
            const need = Math.round(rect.bottom + KEYBOARD_GAP - visible);
            const lift = Math.max(0, Math.min(need, Math.round(rect.top - vv.offsetTop - 16)));
            target.style.setProperty('transition', 'translate 280ms cubic-bezier(0.32, 0.72, 0, 1)');
            target.style.setProperty('translate', lift ? `0 ${-lift}px` : '');
        };
        place();
        vv.addEventListener('resize', place);
        vv.addEventListener('scroll', place);
        return () => {
            vv.removeEventListener('resize', place);
            vv.removeEventListener('scroll', place);
            target.style.removeProperty('translate');
        };
    }, [ref, active]);
}

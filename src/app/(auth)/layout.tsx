import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * Auth shell — full-bleed, with the rdb brand mark pinned top-start. Individual
 * auth screens own their vertical layout (and the reserved on-screen-keyboard
 * space at the bottom).
 *
 * NOTE: the top-start mark size/inset is an assumption pending XD values.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
    return (
        // `h-full`, not `h-screen`. `h-screen` is `100vh`, which on iOS Safari
        // is the LARGE viewport — the height with the toolbar hidden — so the
        // foot of every auth screen would sit behind Safari's bar. `h-full`
        // inherits the body's `100svh` instead, which is the visible box.
        <div className="relative h-full overflow-hidden">
            {/*
              `z-10` is load-bearing, not decoration.

              This mark is absolutely positioned and painted BEFORE `{children}`,
              so with both at the default stacking level the children win on
              document order — and every KYC screen fills its box with
              `bg-white`. The result is a wordmark with a bite out of it:
              partially covered on each of those screens, which reads as a
              broken asset rather than a stacking mistake.

              Lifting it keeps it above whatever a screen paints. Nothing is
              designed to sit in this corner, so there is nothing for it to
              obscure in return.
            */}
            <div className="absolute top-30 start-30 z-10">
                <Icon name="auth/rdb" width={72} height={52} alt="Ramaaz Digital Banking" />
                <p className="text-[#388CFF] text-center mt-4 font-medium">Root</p>
            </div>

            {children}
        </div>
    );
}

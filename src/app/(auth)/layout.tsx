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
            <div className="absolute top-30 start-30">
                <Icon name="auth/rdb" width={72} height={52} alt="Ramaaz Digital Banking" />
                <p className="text-[#388CFF] text-center mt-4 font-medium">Root</p>
            </div>

            {children}
        </div>
    );
}

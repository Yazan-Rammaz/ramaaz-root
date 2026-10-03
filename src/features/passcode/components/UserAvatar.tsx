'use client';

import { Icon } from '@/components/ui/Icon';
import { PhotoGlass } from '@/features/kyc/components/PhotoGlass';
import { cn } from '@/lib/utils/cn';
import { useAdminPhoto } from '../use-passcode';

/**
 * This administrator's picture — the photo the backend stores for the account.
 *
 * ── The first paint is always the glyph ─────────────────────────────────────
 * The photo is fetched after mount (`useAdminPhoto`), so the server and the
 * hydration pass both draw the fallback and the picture replaces it when it
 * lands. An account with no photo — or a signature that has expired — simply
 * keeps the glyph.
 *
 * ── The plate belongs to the CALLER ─────────────────────────────────────────
 * Background and clipping stay outside. This fills whatever box it is given
 * (`object-cover`), so a portrait and a square both crop sensibly.
 *
 * ── The photograph is under glass, NOT mirrored ─────────────────────────────
 * Liquid glass (`PhotoGlass`, the app's one implementation of the material)
 * is the blur the lock screen asks for; the backend sends the original. The
 * pane draws a filtered copy of the SAME src, which is what keeps it registered
 * to the pixel. It needs the frame's radius (`rounded`) or its bevel dies at
 * the corners.
 *
 * Not flipped: this is a stored photo, not a selfie from the capture flow, so
 * `MIRROR_CLASS` would show it back to front — on both layers, or they drift.
 */
export function UserAvatar({
    width,
    height,
    alt = '',
    className,
    rounded = 'rad-20',
}: {
    /** XD px — passed to the fallback glyph so both sources are the same box. */
    width: number;
    height: number;
    alt?: string;
    className?: string;
    /** The frame's own `rad-*` — the glass pane must match it. */
    rounded?: string;
}) {
    const photo = useAdminPhoto();

    if (!photo) {
        return (
            <Icon
                name="side/avatar"
                width={width}
                height={height}
                alt={alt}
                className={cn('h-full w-full object-cover', className)}
            />
        );
    }

    return (
        // A `blob:` URL, so next/image has nothing to optimise and would only
        // route a local string through a loader. The same sanctioned exception
        // <Icon> and <PhotoGlass> carry.
        <div className="relative h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={photo}
                alt={alt}
                aria-hidden={alt === ''}
                draggable={false}
                className={cn('h-full w-full object-cover select-none', className)}
            />
            <PhotoGlass
                src={photo}
                width={width}
                amount={70}
                mirrored={false}
                className={rounded}
            />
        </div>
    );
}

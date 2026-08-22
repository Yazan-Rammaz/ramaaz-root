import { cn } from '@/lib/utils/cn';

type IconProps = {
    /**
     * File name in /public/icons. Extension-less names resolve to .svg
     * ("user" -> /icons/user.svg); XD bitmap exports keep their extension
     * ("regions/geo/flag-tr.png" -> /icons/regions/geo/flag-tr.png).
     */
    name: string;
    /** Square size in XD pixels (scales with the canvas). Ignored if width/height set. */
    size?: number;
    /** Non-square XD pixel dimensions (brand/illustration assets). Override `size`. */
    width?: number;
    height?: number;
    className?: string;
    /** Accessible label; leave empty for decorative icons. */
    alt?: string;
    /**
     * mask=true recolors a monochrome icon with the current text color
     * (`text-foreground`, `text-red-500`, …). Use for single-color UI glyphs.
     * mask=false renders the icon as-is (multicolor brand/illustration icons).
     */
    mask?: boolean;
};

/**
 * The ONLY way to render an icon. XD exports icons as .svg files into
 * /public/icons; this component renders them WITHOUT inlining any <svg> into the
 * page markup (per spec: no svg in pages). Always `<Icon name="…" />`.
 */
export function Icon({
    name,
    size = 24,
    width,
    height,
    className,
    alt = '',
    mask = false,
}: IconProps) {
    const src = name.includes('.') ? `/icons/${name}` : `/icons/${name}.svg`;
    // XD px -> scaling rem. width/height win over the square `size`.
    const style = {
        width: `${(width ?? size) * 0.0625}rem`,
        height: `${(height ?? size) * 0.0625}rem`,
    } as const;

    if (mask) {
        return (
            <span
                aria-hidden
                className={cn('inline-block bg-current', className)}
                style={{
                    ...style,
                    WebkitMaskImage: `url(${src})`,
                    maskImage: `url(${src})`,
                    WebkitMaskRepeat: 'no-repeat',
                    maskRepeat: 'no-repeat',
                    WebkitMaskSize: 'contain',
                    maskSize: 'contain',
                    WebkitMaskPosition: 'center',
                    maskPosition: 'center',
                }}
            />
        );
    }

    return (
        // Intentionally a plain <img>: next/image should not optimize svg, and these
        // are tiny static assets. eslint-disable kept local to this single sanctioned spot.
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt={alt}
            aria-hidden={alt === ''}
            draggable={false}
            className={cn('inline-block select-none', className)}
            style={style}
        />
    );
}

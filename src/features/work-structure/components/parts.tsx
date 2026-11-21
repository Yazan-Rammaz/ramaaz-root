'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { flagEmoji, resolveFlag } from '@/features/region/mock-geo';

/*
 * The pieces every work-structure panel is made of (XD "Root Dashboard home
 * page" 9–40): a titled grey box of choices, the round choice itself, the tab
 * strip, the flag strip, and a label-over-value field.
 */

const SMALL_BLUE = { '--hairline-radius': '0.3125rem', '--hairline-color': '#388cff' } as CSSProperties;
const BLUE = '#388cff';

/** A section title inside a panel (fz-12, ink), with an optional glyph before it. */
export function PanelTitle({ icon, children }: { icon?: string; children: ReactNode }) {
    return (
        <span className="fz-12 text-ink flex items-center gap-4">
            {icon && <Icon name={icon} size={12} />}
            {children}
        </span>
    );
}

/** A #fcfcfc box of choices with its small grey label on top ("Access Method"). */
export function ChoiceBox({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <div className={cn('bg-surface rad-12 flex flex-col gap-6 px-12 py-8', className)}>
            {label && <span className="fz-10 text-muted">{label}</span>}
            {children}
        </div>
    );
}

/**
 * One round choice: blue when on, grey when off — the same mark whether the
 * group picks one (a radio) or several (a check list), as in the design.
 */
export function Choice({
    on,
    label,
    onChange,
    icon,
    disabled,
    tint,
}: {
    on: boolean;
    label: ReactNode;
    onChange?: () => void;
    icon?: string;
    disabled?: boolean;
    /** A top-level pick in a data tree is green, as in the frames. */
    tint?: 'green' | 'red';
}) {
    const color = on ? (tint === 'green' ? '#3fae7c' : tint === 'red' ? '#e5707a' : BLUE) : '#c3c3c3';
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={disabled}
            onClick={onChange}
            className="fz-12 text-ink flex items-center gap-6 text-start disabled:cursor-default"
        >
            <span
                aria-hidden
                className="grid h-12 w-12 shrink-0 place-items-center rounded-full"
                style={{ boxShadow: `inset 0 0 0 0.0625rem ${color}` }}
            >
                <span className="h-8 w-8 rounded-full" style={{ backgroundColor: color }} />
            </span>
            {icon && <Icon name={icon} size={12} />}
            {label}
        </button>
    );
}

/** A row of choices of which exactly one is picked. */
export function OneOf<T extends string>({
    options,
    value,
    label,
    onChange,
    disabled,
}: {
    options: readonly T[];
    value: T;
    label: (o: T) => ReactNode;
    onChange: (o: T) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-wrap gap-x-16 gap-y-6">
            {options.map((o) => (
                <Choice key={o} on={value === o} label={label(o)} disabled={disabled} onChange={() => onChange(o)} />
            ))}
        </div>
    );
}

/** A strip of 26×26 tab glyphs; the open one framed blue. */
export function TabStrip<T extends string>({
    tabs,
    value,
    icon,
    label,
    onChange,
    className,
}: {
    tabs: readonly T[];
    value: T;
    icon: (t: T) => string;
    label: (t: T) => string;
    onChange: (t: T) => void;
    className?: string;
}) {
    return (
        <div className={cn('bg-surface rad-12 flex h-50 items-center gap-6 ps-8', className)}>
            {tabs.map((id) => (
                <button
                    key={id}
                    type="button"
                    onClick={() => onChange(id)}
                    aria-pressed={value === id}
                    aria-label={label(id)}
                    style={value === id ? SMALL_BLUE : undefined}
                    className={cn('rad-5 grid h-26 w-26 place-items-center', value === id && 'hairline')}
                >
                    {/* Selected #1D1D1D, the rest #8D8D8D — every tab and sub-tab strip (XD). */}
                    <Icon name={icon(id)} size={16} mask className={value === id ? 'text-[#1D1D1D]' : 'text-[#8D8D8D]'} />
                </button>
            ))}
        </div>
    );
}

/** The project's flags in 34×34 white boxes (XD Group 16537); `framed` rings each one blue. */
export function FlagStrip({ codes, framed = true }: { codes: string[]; framed?: boolean }) {
    return (
        <div className="bg-surface rad-12 flex min-h-50 flex-wrap items-center gap-6 px-8 py-8">
            {codes.map((code) => {
                const flag = resolveFlag(code);
                return (
                    <span
                        key={code}
                        className={cn('rad-10 grid h-34 w-34 place-items-center', framed && 'hairline bg-white')}
                        style={framed ? ({ '--hairline-radius': '0.625rem', '--hairline-color': BLUE } as CSSProperties) : undefined}
                    >
                        {flag ? (
                            <Icon name={flag.icon} width={18} height={12} />
                        ) : (
                            <span className="fz-14 leading-none">{flagEmoji(code)}</span>
                        )}
                    </span>
                );
            })}
        </div>
    );
}

/** A label over its value in a #fcfcfc box; `editLabel` puts the blue "Edit" before the label, a button with `onEdit`. */
export function InfoField({
    label,
    value,
    onEdit,
    editLabel,
}: {
    label: ReactNode;
    value: ReactNode;
    onEdit?: () => void;
    editLabel?: string;
}) {
    return (
        <div className="bg-surface rad-12 flex min-h-50 flex-col justify-center gap-4 px-12 py-8">
            <span className="fz-10 text-muted">
                {onEdit ? (
                    <button type="button" onClick={onEdit} className="text-primary me-4 cursor-pointer">
                        {editLabel}
                    </button>
                ) : (
                    // The design's Edit on a field nothing can change yet.
                    editLabel && <span className="text-primary me-4">{editLabel}</span>
                )}
                {label}
            </span>
            <span className="fz-12 text-ink">{value}</span>
        </div>
    );
}

/**
 * A labelled input in a dashed box — empty, it is dashed; once a value is
 * entered and the field is left, it turns into the "entered" box of XD work
 * structure 7: solid #fcfcfc, a blue **Edit** before the label, the value
 * under it, read-only. Edit (or a tap on the box) opens it again.
 */
export function DashedInput({
    label,
    value,
    onChange,
    multiline,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    multiline?: boolean;
}) {
    const t = useTranslations('work');
    const [editing, setEditing] = useState(false);
    const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    const empty = !value.trim();
    const entered = !empty && !editing;
    const open = () => {
        setEditing(true);
        requestAnimationFrame(() => field.current?.focus());
    };
    const common = {
        ref: field,
        value,
        readOnly: entered,
        onFocus: () => setEditing(true),
        onBlur: () => setEditing(false),
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    };
    return (
        <label
            className={cn('rad-12 relative flex min-h-54 flex-col gap-4 px-12 py-8', !empty && 'bg-surface')}
            style={
                empty
                    ? ({ outline: '0.0625rem dashed #c3c3c3', outlineOffset: '-0.0625rem' } as CSSProperties)
                    : undefined
            }
        >
            <span className="fz-10 text-muted">
                {entered && (
                    <button type="button" onClick={open} className="me-4 cursor-pointer text-[#388CFF]">
                        {t('edit')}
                    </button>
                )}
                {label}
            </span>
            {multiline ? (
                <textarea {...common} rows={3} className="fz-12 text-ink w-full resize-none bg-transparent outline-none" />
            ) : (
                <input {...common} className="fz-12 text-ink w-full bg-transparent outline-none" />
            )}
        </label>
    );
}

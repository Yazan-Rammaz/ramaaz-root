'use client';

import { useTranslations } from 'next-intl';
import { rowLanguages, type NameLanguage, type NameRow } from '@/features/language/names';
import { ChipLine, type Phase } from './AddCountryDrawer';

/**
 * A name's translation rows — one per language the project lists
 * (`2026-11-08-languages-screen-and-names.md` §1), the one place the status
 * rules live, for every name form (countries, regions, region types,
 * currencies, roles):
 *
 *   ACTIVE    a plain row; `en` and `ar` must be filled (the form checks).
 *   DRAFT     a row too, marked "not shown to customers": text can be written
 *             before the language goes live.
 *   INACTIVE  no new text. Only a row the stored name still has text in shows,
 *             read-only, with Remove (sent as `null` on save).
 *
 * Each input takes its language's own direction — the text in it is in that
 * language whatever the interface is, which `<html dir>` cannot know. RDB's
 * message for a row (`422` on `name.<code>`) shows under that row.
 *
 * `rows` null = the AI pass hasn't answered yet: placeholder rows shimmer.
 * `filling` = the rows the AI is filling right now (`useAutoNames`): only
 * those shimmer, the rest stay editable. Without it, `phase` sets them all.
 * `skip` leaves out rows the form shows elsewhere (English, in its own field).
 */
export function NameRows({
    languages,
    rows,
    phase,
    onChange,
    errors,
    skip = [],
    filling,
    onRetranslate,
}: {
    languages: NameLanguage[];
    rows: NameRow[] | null;
    phase: Phase;
    filling?: ReadonlySet<string>;
    /** A row's chip translates that language again. */
    onRetranslate?: (chip: string) => void;
    onChange?: (rows: NameRow[]) => void;
    /** RDB's per-field messages, keyed `name.<code>`. */
    errors?: Record<string, string>;
    skip?: string[];
}) {
    const t = useTranslations('region.names');

    if (!rows) {
        const count = rowLanguages(languages).filter((l) => !skip.includes(l.chip)).length;
        return (
            <>
                {Array.from({ length: count }, (_, i) => (
                    <ChipLine key={i} phase={phase} />
                ))}
            </>
        );
    }

    const set = (chip: string, name: string) =>
        onChange?.(rows.map((r) => (r.code === chip ? { ...r, name } : r)));

    return (
        <>
            {rows
                .filter((r) => !skip.includes(r.code))
                .map((r) => {
                    const lang = languages.find((l) => l.chip === r.code);
                    const error = lang ? errors?.[`name.${lang.code}`] : undefined;
                    return (
                        <div key={r.code} className="flex flex-col gap-4">
                            {lang?.status === 'INACTIVE' ? (
                                <InactiveRow
                                    chip={r.code}
                                    value={r.name}
                                    dir={lang.direction}
                                    onRemove={onChange ? () => set(r.code, '') : undefined}
                                />
                            ) : (
                                <ChipLine
                                    phase={filling ? (filling.has(r.code) ? 'gen' : 'ready') : phase}
                                    code={r.code}
                                    value={r.name}
                                    dir={lang?.direction}
                                    onChange={onChange ? (v) => set(r.code, v) : undefined}
                                    onChip={onRetranslate && onChange ? () => onRetranslate(r.code) : undefined}
                                />
                            )}
                            {phase === 'ready' && lang?.status === 'DRAFT' && (
                                <span className="fz-12 text-muted ps-58">{t('draft')}</span>
                            )}
                            {error && <span className="fz-12 ps-58 text-red-500">{error}</span>}
                        </div>
                    );
                })}
        </>
    );
}

/** A language set INACTIVE: its stored text, read-only, and Remove. */
function InactiveRow({
    chip,
    value,
    dir,
    onRemove,
}: {
    chip: string;
    value: string;
    dir: 'ltr' | 'rtl';
    onRemove?: () => void;
}) {
    const t = useTranslations('region.names');
    const removed = !value.trim();
    return (
        <div className="flex items-center gap-8">
            <span className="fz-12 bg-surface text-muted rad-12 grid h-50 w-50 shrink-0 place-items-center font-semibold">
                {chip}
            </span>
            <span
                dir={removed ? undefined : dir}
                className="bg-surface rad-12 fz-14 text-muted flex h-50 min-w-0 flex-1 items-center truncate px-12"
            >
                {removed ? t('removed') : value}
            </span>
            {onRemove && !removed && (
                <button type="button" onClick={onRemove} className="fz-12 shrink-0 font-medium text-red-500">
                    {t('remove')}
                </button>
            )}
            {!onRemove && <span className="fz-12 text-muted shrink-0">{t('inactive')}</span>}
        </div>
    );
}

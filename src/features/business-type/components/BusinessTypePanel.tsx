'use client';

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { missingRequired, nameForCreate, nameRows, type NameLanguage, type NameRow } from '@/features/language/names';
import { translateNameAction } from '@/features/region/ai';
import { useAutoNames } from '@/features/region/use-auto-names';
import { Field, Section, translationOf } from '@/features/region/components/AddCountryDrawer';
import { NameRows } from '@/features/region/components/NameRows';
import { flagEmoji, resolveFlag } from '@/features/region/mock-geo';
import { pickRoleName } from '@/features/role/components/RolePanel';
import type { RoleCountry } from '@/features/role/schema';
import { SHORT_NAME, type BusinessKind, type BusinessType } from '../schema';

/** The blue frame on the panel's small 26×26 boxes (ⓘ / ⚙): its corner follows theirs (`rad-5`). */
const BLUE = { '--hairline-radius': '0.3125rem', '--hairline-color': '#388cff' } as CSSProperties;

/** A flag box's frame (XD Group 16537): 0.5 #388cff when the type is available there, the muted line when not. */
const flagFrame = (on: boolean) =>
    ({ '--hairline-radius': '0.625rem', '--hairline-color': on ? '#388cff' : 'var(--color-muted)' }) as CSSProperties;

/**
 * The right column of the business-type screen (XD "Center Dash" 55–58): the
 * "Business Type" strip, the project's country flags, the ⓘ / ⚙ tabs, then —
 * on ⓘ — availability (every country, or the flags picked), the short name
 * and name, and the name in every language the project lists, filled in by
 * the AI pass from the English name (anything typed by hand stays).
 *
 * ⚠️ Design only: Save hands the result back to the list, which keeps it on
 * the screen until a reload. Nothing reaches a backend yet (see `api.ts`).
 * Mounted per type (keyed by the list), so its form starts from that type.
 */
export function BusinessTypePanel({
    type,
    kind,
    countries,
    languages,
    onSaved,
}: {
    /** Null = a new one, of `kind`. */
    type: BusinessType | null;
    kind: BusinessKind;
    countries: RoleCountry[];
    languages: NameLanguage[];
    onSaved: (type: BusinessType) => void;
}) {
    const t = useTranslations('businessType');
    const locale = useLocale();
    const [tab, setTab] = useState<'info' | 'settings'>('info');
    const [shortName, setShortName] = useState(type?.short_name ?? '');
    const [rows, setRows] = useState<NameRow[]>(() => nameRows(languages, type?.name));
    const [allCountries, setAllCountries] = useState(type?.all_countries ?? true);
    const [picked, setPicked] = useState<Set<string>>(() => new Set(type?.countries ?? []));

    // ── The other languages, from the English name (the AI pass) ───────────
    // Fills empty rows as soon as the panel opens — a language added since this
    // was saved — and again after the English name changes; typed rows stay.
    const en = translationOf(rows, 'EN');
    const auto = useAutoNames({
        en,
        rows,
        setRows,
        ask: async (text) => ({ translations: await translateNameAction(text, 'a type of business relationship or business place in an administration console') }),
    });
    const aiPhase = auto.phase;

    const canSave =
        SHORT_NAME.test(shortName.trim()) &&
        !missingRequired(languages, rows) &&
        (allCountries || picked.size > 0);

    function save() {
        onSaved({
            id: type?.id ?? `new-${Date.now()}`,
            kind: type?.kind ?? kind,
            short_name: shortName.trim().toUpperCase(),
            name: nameForCreate(languages, rows),
            all_countries: allCountries,
            countries: allCountries ? [] : [...picked],
        });
    }

    return (
        <>
            <div className="thin-scroll flex flex-1 flex-col gap-4 overflow-y-auto pe-12">
                {/* "Business Type" strip. */}
                <span className="bg-surface rad-12 fz-14 text-ink flex h-50 items-center gap-8 ps-12">
                    <Icon name="nav/business" size={18} mask />
                    {t('panel.title')}
                </span>

                {/* The project's countries (XD Group 16537): a 50-tall #fcfcfc strip of
                    34×34 white boxes, radius 10, 6 apart, each framed blue where the
                    type is available, with its 18-wide flag centred. */}
                <div className="bg-surface rad-12 flex min-h-50 flex-wrap items-center gap-6 px-8 py-8">
                    {countries.map((c) => {
                        const flag = c.code ? resolveFlag(c.code) : undefined;
                        const on = allCountries || picked.has(c.id);
                        const label = pickRoleName(c.name, locale);
                        return (
                            <button
                                key={c.id}
                                type="button"
                                disabled={allCountries}
                                aria-pressed={on}
                                title={label}
                                onClick={() =>
                                    setPicked(
                                        new Set(picked.has(c.id) ? [...picked].filter((x) => x !== c.id) : [...picked, c.id]),
                                    )
                                }
                                style={flagFrame(on)}
                                className={cn(
                                    'hairline rad-10 grid h-34 min-w-34 place-items-center bg-white px-8',
                                    !on && 'opacity-50',
                                    c.closed && 'grayscale',
                                )}
                            >
                                {flag ? (
                                    <Icon name={flag.icon} width={18} height={12} />
                                ) : c.code ? (
                                    <span className="fz-14 leading-none">{flagEmoji(c.code)}</span>
                                ) : (
                                    <span className="fz-10 text-ink">{label}</span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* ⓘ / ⚙ */}
                <div className="bg-surface rad-12 flex h-50 items-center gap-6 ps-6">
                    {(['info', 'settings'] as const).map((id) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setTab(id)}
                            aria-pressed={tab === id}
                            aria-label={t(`panel.${id}`)}
                            style={tab === id ? BLUE : undefined}
                            className={cn(
                                'rad-5 text-ink grid h-26 w-26 place-items-center',
                                tab === id ? 'hairline' : 'text-muted',
                            )}
                        >
                            {/* Their own colours (info #1D1D1D, gear #8D8D8D); the blue frame marks the open one. */}
                            <Icon name={id === 'info' ? 'roles/info' : 'roles/gear'} size={16} />
                        </button>
                    ))}
                </div>

                {tab === 'info' ? (
                    <div className="flex flex-col gap-16 px-6 pt-12">
                        <Section title={t('availability.title')}>
                            <div className="bg-surface rad-12 flex flex-col gap-6 px-12 py-8">
                                <span className="fz-10 text-muted">{t('availability.all')}</span>
                                <div className="fz-12 text-ink flex gap-16">
                                    {([true, false] as const).map((on) => (
                                        <label key={String(on)} className="flex cursor-pointer items-center gap-6">
                                            <input
                                                type="radio"
                                                name="business-type-availability"
                                                checked={allCountries === on}
                                                onChange={() => setAllCountries(on)}
                                                className="accent-primary"
                                            />
                                            {on ? t('availability.enable') : t('availability.disable')}
                                        </label>
                                    ))}
                                </div>
                            </div>
                            {!allCountries && picked.size === 0 && (
                                <span className="fz-10 text-muted">{t('availability.pick')}</span>
                            )}
                        </Section>

                        <Section title={t('name.title')}>
                            <div className="flex gap-4">
                                <Field
                                    className="w-128 shrink-0"
                                    label={t('name.short')}
                                    hint={t('name.shortHint')}
                                    value={shortName}
                                    maxLength={4}
                                    onChange={setShortName}
                                />
                                <Field
                                    className="flex-1"
                                    label={t('name.label')}
                                    value={en}
                                    maxLength={200}
                                    aiPhase={aiPhase}
                                    onChange={(v) => setRows(rows.map((r) => (r.code === 'EN' ? { ...r, name: v } : r)))}
                                />
                            </div>
                        </Section>

                        <Section title={t('name.translation')} phase={aiPhase} ai onAi={auto.retranslate}>
                            <NameRows
                                languages={languages}
                                rows={rows}
                                phase={aiPhase}
                                filling={auto.filling}
                                onRetranslate={auto.retranslateOne}
                                skip={['EN']}
                                onChange={(next) => {
                                    auto.typed(rows, next);
                                    setRows(next);
                                }}
                            />
                        </Section>
                    </div>
                ) : (
                    <span className="fz-12 text-muted px-6 pt-12">{t('panel.settingsSoon')}</span>
                )}
            </div>

            <div className="flex shrink-0 flex-col gap-8 pe-12 pt-12 pb-24">
                <button
                    type="button"
                    onClick={save}
                    disabled={!canSave}
                    className="bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center font-medium text-white disabled:opacity-50"
                >
                    ↳ {type ? t('save.edit') : t('save.add')}
                </button>
            </div>
        </>
    );
}

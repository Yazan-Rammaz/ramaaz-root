'use client';

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import {
    missingRequired,
    nameForCreate,
    nameRows,
    rowLanguages,
    type NameLanguage,
    type NameRow,
} from '@/features/language/names';
import { translateNameAction } from '@/features/region/ai';
import { useAutoNames } from '@/features/region/use-auto-names';
import { Field, Section, translationOf } from '@/features/region/components/AddCountryDrawer';
import { NameRows } from '@/features/region/components/NameRows';
import { pickRoleName } from '@/features/role/components/RolePanel';
import { ChoiceBox, FlagStrip, OneOf, PanelTitle, TabStrip } from '@/features/work-structure/components/parts';
import type { DashboardType } from '../schema';

const BLUE = { '--hairline-radius': '0.625rem', '--hairline-color': '#388cff' } as CSSProperties;

/**
 * The right panel of the dashboard-types screen (XD "Center Dash" 54): the
 * type's logo and name strip, the project's flags, ⓘ / ⚙, then on ⓘ —
 * availability, the logo (an SVG file), the name with its translations in
 * every language the project lists (the AI fills them from the English name;
 * anything typed stays), and the one language its dashboards open in.
 *
 * ⚠️ Design only: Save hands the result back to the list, which keeps it on
 * the screen until a reload; a picked logo stays in this browser. Nothing
 * reaches a backend yet (see `api.ts`). Mounted per type (keyed by the list).
 */
export function DashboardTypePanel({
    type,
    logoFile,
    countries,
    languages,
    onSaved,
}: {
    /** Null = a new one. */
    type: DashboardType | null;
    /** A logo picked earlier for this type (an object URL). */
    logoFile?: string;
    countries: string[];
    languages: NameLanguage[];
    onSaved: (type: DashboardType, logoFile?: string) => void;
}) {
    const t = useTranslations('dashboardType');
    const locale = useLocale();
    const [tab, setTab] = useState<'info' | 'settings'>('info');
    const [rows, setRows] = useState<NameRow[]>(() => nameRows(languages, type?.name));
    const [allCountries, setAllCountries] = useState(type?.all_countries ?? true);
    const [language, setLanguage] = useState(type?.language ?? 'en');
    const [logo, setLogo] = useState(logoFile);

    // ── The other languages, from the English name (the AI pass) ───────────
    // Fills empty rows as soon as the panel opens — a language added since this
    // was saved — and again after the English name changes; typed rows stay.
    const en = translationOf(rows, 'EN');
    const auto = useAutoNames({
        en,
        rows,
        setRows,
        ask: async (text) => ({ translations: await translateNameAction(text, 'a type of management dashboard in an administration console') }),
    });
    const aiPhase = auto.phase;

    const name = nameForCreate(languages, rows);
    const shown = pickRoleName(name, locale) || t('newType');

    function save() {
        onSaved(
            {
                id: type?.id ?? `new-${Date.now()}`,
                short_name: type?.short_name ?? (en.trim()[0] ?? '?').toUpperCase(),
                name,
                logo: type?.logo ?? 'nav/database',
                all_countries: allCountries,
                countries: type?.countries ?? [],
                language,
            },
            logo,
        );
    }

    return (
        <>
            <div className="thin-scroll flex flex-1 flex-col gap-4 overflow-y-auto">
                {/* The type's logo and name. */}
                <span className="bg-surface rad-12 fz-12 text-ink flex h-50 shrink-0 items-center gap-8 ps-12">
                    <Logo file={logo} icon={type?.logo} size={14} />
                    <span className="truncate">{shown}</span>
                </span>
                <FlagStrip codes={countries} />
                <TabStrip
                    tabs={['info', 'settings'] as const}
                    value={tab}
                    icon={(id) => (id === 'info' ? 'roles/info' : 'roles/gear')}
                    label={(id) => t(`panel.${id}`)}
                    onChange={setTab}
                />

                {tab === 'info' ? (
                    <div className="flex flex-col gap-8 px-4 pt-8">
                        <PanelTitle>{t('availability.title')}</PanelTitle>
                        <ChoiceBox label={t('availability.all')}>
                            <OneOf
                                options={['enable', 'disable'] as const}
                                value={allCountries ? 'enable' : 'disable'}
                                label={(o) => t(`availability.${o}`)}
                                onChange={(o) => setAllCountries(o === 'enable')}
                            />
                        </ChoiceBox>

                        <PanelTitle>{t('logo.title')}</PanelTitle>
                        <label className="bg-surface rad-12 grid h-34 w-34 cursor-pointer place-items-center" title={t('logo.pick')}>
                            <Logo file={logo} icon={type?.logo} size={20} />
                            <input
                                type="file"
                                accept="image/svg+xml"
                                className="sr-only"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) setLogo(URL.createObjectURL(file));
                                }}
                            />
                        </label>

                        <PanelTitle>{t('name.title')}</PanelTitle>
                        <Field
                            className="hairline"
                            label={t('name.label')}
                            value={en}
                            maxLength={200}
                            aiPhase={aiPhase}
                            onChange={(v) => setRows(rows.map((r) => (r.code === 'EN' ? { ...r, name: v } : r)))}
                        />
                        <Section title={t('name.translation')} phase={aiPhase} ai onAi={auto.retranslate}>
                            {null}
                        </Section>
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

                        <span className="fz-12 text-muted">{t('language', { count: 1 })}</span>
                        <div className="flex gap-6">
                            {rowLanguages(languages).map((l) => (
                                <button
                                    key={l.code}
                                    type="button"
                                    onClick={() => setLanguage(l.code)}
                                    aria-pressed={language === l.code}
                                    aria-label={l.label}
                                    className={cn('rad-10 grid h-34 w-34 place-items-center', language === l.code && 'hairline')}
                                    style={BLUE}
                                >
                                    <span className="bg-ink rad-5 fz-10 grid h-20 min-w-24 place-items-center px-2 font-semibold text-white">
                                        {l.chip}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <span className="fz-12 text-muted px-4 pt-8">{t('panel.settingsSoon')}</span>
                )}
            </div>

            <button
                type="button"
                onClick={save}
                disabled={missingRequired(languages, rows)}
                className="bg-primary fz-14 rad-12 mt-12 flex h-50 w-full shrink-0 items-center justify-center font-medium text-white disabled:opacity-50"
            >
                ↳ {type ? t('save.edit') : t('save.add')}
            </button>
        </>
    );
}

/** The type's logo: a picked SVG file (an object URL), else our glyph for it. */
function Logo({ file, icon, size }: { file?: string; icon?: string; size: number }) {
    return file ? (
        // A picked file — content, not one of our icons, so not <Icon>.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file} alt="" style={{ width: `${size * 0.0625}rem`, height: `${size * 0.0625}rem` }} />
    ) : (
        <Icon name={icon ?? 'nav/database'} size={size} />
    );
}

'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { pickName } from '@/lib/i18n/localized';
import { cn } from '@/lib/utils/cn';
import { useAddAction } from '@/features/shell/add-action';
import type { LanguageAccess } from '../api';
import type { Coverage, Language } from '../schema';
import { AddLanguageDrawer, EditLanguageDrawer } from './LanguageDrawer';

const BLUE = { '--hairline-radius': '0.75rem', '--hairline-color': '#388cff' } as CSSProperties;

/**
 * "System Languages" — exact from the XD export (system-languages/*.svg): the
 * shared SectionHeader (translate icon, brand-blue #388cff outline), then a
 * column of 50-tall rows. Each row is a 50×50 slot holding a 26×26 black
 * (#1d1d1d, radius 5) code chip with the code in white, next to a 352×50
 * #fcfcfc card with the language name (14px Quicksand, ink).
 *
 * The languages are the selected project's own, from RDB
 * (`2026-11-08-languages-screen-and-names.md` §3). The row stays as designed;
 * the rest — status, direction, fallback, coverage — is in the sheet a row
 * opens. Read-only unless the person holds `languages:write`: then the navbar
 * "+" adds a language (`?add=language`) and a row opens its sheet. After any
 * change the page is read again (`router.refresh()`), so the list is always
 * RDB's own.
 */
export function LanguageList({
    items,
    coverage,
    access,
}: {
    items: Language[];
    /** Null when it could not be read: the panel is hidden, and activation says so. */
    coverage: Coverage | null;
    access: LanguageAccess;
}) {
    const t = useTranslations('language');
    const locale = useLocale();
    const router = useRouter();
    const params = useSearchParams();
    const adding = params.get('add') === 'language' && access.create;
    const [selected, setSelected] = useState<string | null>(null);
    const language = selected ? items.find((l) => l.code === selected) : undefined;
    const canOpen = access.update || access.status;
    const coverageOf = (code: string) => coverage?.languages.find((c) => c.code === code);

    // The navbar "+" adds a language — only for someone who may.
    const { setHref, setOnClose } = useAddAction();
    useEffect(() => {
        setHref(access.create ? '/languages?add=language' : null);
        return () => setHref(null);
    }, [access.create, setHref]);
    // An open sheet is closed by the navbar's Close.
    useEffect(() => {
        if (!selected) return;
        setOnClose(() => setSelected(null));
        return () => setOnClose(null);
    }, [selected, setOnClose]);

    const reload = () => router.refresh();

    return (
        <div className="flex h-full">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                <SectionHeader icon="nav/translate" title={t('title')} count={items.length} borderColor="#388cff" />

                {items.length === 0 ? (
                    <p className="fz-14 text-ink mt-12 ps-12 font-light">{t('empty')}</p>
                ) : (
                    <ul className="mt-12 flex flex-col gap-4 ps-12">
                        {items.map((item) => {
                            // Exact from the XD row: the 352×50 #fcfcfc card with the name.
                            const cardClass = 'bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12 text-start';
                            const name = <span className="fz-14 text-ink">{pickName(item.name, locale)}</span>;
                            return (
                                <li key={item.code} className="flex gap-4">
                                    {/* Leading slot — holds the black code chip, centered. */}
                                    <span className="bg-surface rad-12 flex h-50 w-50 shrink-0 items-center justify-center">
                                        <span className="bg-ink rad-5 fz-12 flex h-26 w-26 items-center justify-center font-semibold text-white">
                                            {item.code.toUpperCase()}
                                        </span>
                                    </span>
                                    {canOpen ? (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (adding) router.replace('/languages');
                                                setSelected(item.code);
                                            }}
                                            aria-pressed={selected === item.code}
                                            className={cn(cardClass, selected === item.code && 'hairline')}
                                            style={BLUE}
                                        >
                                            {name}
                                        </button>
                                    ) : (
                                        <div className={cardClass}>{name}</div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <AnimatePresence>
                {adding ? (
                    <AddLanguageDrawer
                        key="add"
                        onAdded={() => {
                            router.replace('/languages');
                            reload();
                        }}
                    />
                ) : (
                    language && (
                        <EditLanguageDrawer
                            // Read again after a change: a fresh sheet from RDB's new values.
                            key={`${language.code}:${language.updatedAt ?? ''}:${language.status}`}
                            language={language}
                            languages={items}
                            coverage={coverageOf(language.code)}
                            coverageKnown={coverage != null}
                            access={access}
                            onChanged={reload}
                        />
                    )
                )}
            </AnimatePresence>
        </div>
    );
}

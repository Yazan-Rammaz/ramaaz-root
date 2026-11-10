'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import type { NameLanguage } from '@/features/language/names';
import { pickRoleName } from '@/features/role/components/RolePanel';
import type { RoleCountry } from '@/features/role/schema';
import { useAddAction } from '@/features/shell/add-action';
import { BUSINESS_KINDS, type BusinessKind, type BusinessType } from '../schema';
import { BusinessTypePanel } from './BusinessTypePanel';

const BLUE = { '--hairline-radius': '0.75rem', '--hairline-color': '#388cff' } as CSSProperties;

const TAB_ICON: Record<BusinessKind, string> = {
    individual: 'business/individual',
    corporate: 'business/corporate',
    work: 'business/work-type',
};

/**
 * "System Business Type" (XD "Center Dash" 55–58) — the same frame as the
 * roles screen: a tall business-card box, the three kind tabs (Individual,
 * Corporate, Business Work Type) over the "System Business Type | {tab}"
 * strip, then the tab's types — a short-name chip and a 352-wide name card,
 * the selected one framed blue — and the selected type's panel on the end
 * side. The navbar "+" starts a new type of the open tab (`?add=business-type`).
 *
 * ⚠️ Design only — the rows are mocked and a save stays on the screen until a
 * reload (`api.ts`).
 */
export function BusinessTypeList({
    items: initial,
    countries,
    languages,
}: {
    items: BusinessType[];
    countries: RoleCountry[];
    languages: NameLanguage[];
}) {
    const t = useTranslations('businessType');
    const locale = useLocale();
    const router = useRouter();
    const params = useSearchParams();
    const [items, setItems] = useState(initial);
    // The tab is client state, as on Regions and Roles; only "add" is in the URL.
    const [tab, setTab] = useState<BusinessKind>('individual');
    const shown = items.filter((i) => i.kind === tab);
    const [selectedId, setSelectedId] = useState<string | null>(shown[0]?.id ?? null);

    const adding = params.get('add') === 'business-type';
    const closeAdd = () => router.replace('/business-types');
    const selected = adding ? null : (shown.find((i) => i.id === selectedId) ?? null);
    const panelOpen = adding || selected != null;

    const { setHref, setOnClose } = useAddAction();
    useEffect(() => {
        setHref('/business-types?add=business-type');
        return () => setHref(null);
    }, [setHref]);
    useEffect(() => {
        if (!panelOpen) return;
        setOnClose(() => (adding ? closeAdd() : setSelectedId(null)));
        return () => setOnClose(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- closeAdd is a fresh closure over the stable router
    }, [panelOpen, adding, setOnClose]);

    function switchTab(next: BusinessKind) {
        if (adding) closeAdd();
        setTab(next);
        setSelectedId(items.find((i) => i.kind === next)?.id ?? null);
    }

    return (
        <div className="flex h-full gap-12">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                <header className="flex items-stretch gap-4 ps-12">
                    <span
                        className="hairline bg-surface rad-12 flex h-106 w-50 shrink-0 items-center justify-center"
                        style={BLUE}
                    >
                        <Icon name="nav/business" size={26} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-6">
                        {/* Tabs: Individual, Corporate, Business Work Type — the open one framed blue. */}
                        <div className="bg-surface rad-12 flex h-50 items-center gap-4">
                            {BUSINESS_KINDS.map((id) => (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => switchTab(id)}
                                    aria-label={t(`tabs.${id}`)}
                                    aria-pressed={tab === id}
                                    style={tab === id ? BLUE : undefined}
                                    className={cn(
                                        'rad-12 text-ink flex h-50 w-50 shrink-0 items-center justify-center',
                                        tab === id && 'hairline',
                                    )}
                                >
                                    <Icon name={TAB_ICON[id]} size={26} mask />
                                </button>
                            ))}
                        </div>
                        <span className="bg-surface rad-12 flex h-50 items-center ps-12">
                            <span className="fz-14 text-ink font-light">
                                {t('title')} | <span className="font-medium">{t(`tabs.${tab}`)}</span>
                            </span>
                        </span>
                    </div>
                </header>

                {shown.length === 0 ? (
                    <p className="fz-14 text-muted mt-12 ps-12">{t('empty')}</p>
                ) : (
                    <ul className="mt-12 flex flex-col gap-4 ps-12">
                        {shown.map((item) => {
                            const on = !adding && item.id === selectedId;
                            return (
                                <li key={item.id} className="flex gap-4">
                                    <span className="bg-surface rad-12 fz-14 text-ink flex h-50 w-50 shrink-0 items-center justify-center">
                                        {item.short_name}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (adding) closeAdd();
                                            setSelectedId(item.id);
                                        }}
                                        aria-pressed={on}
                                        style={on ? BLUE : undefined}
                                        className={cn(
                                            'bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12 text-start',
                                            on && 'hairline',
                                        )}
                                    >
                                        <span className="fz-14 text-ink truncate">{pickRoleName(item.name, locale)}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {panelOpen && (
                <aside
                    className="flex h-full w-430 max-w-full shrink-0 flex-col"
                    aria-label={selected ? pickRoleName(selected.name, locale) : t('newType')}
                >
                    <BusinessTypePanel
                        key={selected?.id ?? `new-${tab}`}
                        type={selected}
                        kind={tab}
                        countries={countries}
                        languages={languages}
                        onSaved={(saved) => {
                            setItems((list) =>
                                list.some((i) => i.id === saved.id)
                                    ? list.map((i) => (i.id === saved.id ? saved : i))
                                    : [...list, saved],
                            );
                            if (adding) closeAdd();
                            setSelectedId(saved.id);
                        }}
                    />
                </aside>
            )}
        </div>
    );
}

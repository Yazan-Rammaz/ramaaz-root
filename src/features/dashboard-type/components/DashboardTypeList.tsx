'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import type { NameLanguage } from '@/features/language/names';
import { pickRoleName } from '@/features/role/components/RolePanel';
import { useAddAction } from '@/features/shell/add-action';
import type { DashboardType } from '../schema';
import { DashboardTypePanel } from './DashboardTypePanel';

const BLUE = { '--hairline-radius': '0.75rem', '--hairline-color': '#388cff' } as CSSProperties;

/**
 * "System Dashboards Type" (XD "Center Dash" 54): a 50-tall header — the
 * dashboards box framed blue and the title strip — then the types, a short
 * chip and a 352-wide name card each, the selected one framed, and its panel
 * on the end side in a dashed frame. The navbar "+" starts a new type
 * (`?add=dashboard-type`).
 *
 * ⚠️ Design only — the rows are mocked and a save stays on the screen until a
 * reload (`api.ts`).
 */
export function DashboardTypeList({
    items: initial,
    countries,
    languages,
}: {
    items: DashboardType[];
    countries: string[];
    languages: NameLanguage[];
}) {
    const t = useTranslations('dashboardType');
    const locale = useLocale();
    const router = useRouter();
    const params = useSearchParams();
    const [items, setItems] = useState(initial);
    const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
    // A picked logo stays in this browser (an object URL) — design only.
    const [logos, setLogos] = useState<Record<string, string>>({});

    const adding = params.get('add') === 'dashboard-type';
    const closeAdd = () => router.replace('/dashboard-types');
    const selected = adding ? null : (items.find((i) => i.id === selectedId) ?? null);
    const panelOpen = adding || selected != null;

    const { setHref, setOnClose } = useAddAction();
    useEffect(() => {
        setHref('/dashboard-types?add=dashboard-type');
        return () => setHref(null);
    }, [setHref]);
    useEffect(() => {
        if (!panelOpen) return;
        setOnClose(() => (adding ? closeAdd() : setSelectedId(null)));
        return () => setOnClose(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- closeAdd is a fresh closure over the stable router
    }, [panelOpen, adding, setOnClose]);

    return (
        <div className="flex h-full gap-12">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                <header className="flex items-stretch gap-4 ps-12">
                    <span className="hairline bg-surface rad-12 flex h-50 w-50 shrink-0 items-center justify-center" style={BLUE}>
                        <Icon name="nav/database" size={26} />
                    </span>
                    <span className="bg-surface rad-12 flex h-50 min-w-0 flex-1 items-center ps-12">
                        <span className="fz-14 text-ink font-light">{t('title')}</span>
                    </span>
                </header>

                {items.length === 0 ? (
                    <p className="fz-14 text-muted mt-12 ps-12">{t('empty')}</p>
                ) : (
                    <ul className="mt-4 flex flex-col gap-4 ps-12">
                        {items.map((item) => {
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
                    className="relative flex h-full w-430 max-w-full shrink-0 flex-col p-8"
                    aria-label={selected ? pickRoleName(selected.name, locale) : t('newType')}
                >
                    <DashedFrame radius={12} color="#c3c3c3" />
                    <DashboardTypePanel
                        key={selected?.id ?? 'new'}
                        type={selected}
                        logoFile={selected ? logos[selected.id] : undefined}
                        countries={countries}
                        languages={languages}
                        onSaved={(saved, logo) => {
                            setItems((list) =>
                                list.some((i) => i.id === saved.id)
                                    ? list.map((i) => (i.id === saved.id ? saved : i))
                                    : [...list, saved],
                            );
                            if (logo) setLogos((l) => ({ ...l, [saved.id]: logo }));
                            if (adding) closeAdd();
                            setSelectedId(saved.id);
                        }}
                    />
                </aside>
            )}
        </div>
    );
}

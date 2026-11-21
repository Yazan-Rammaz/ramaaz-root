'use client';

import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { pickRoleName } from '@/features/role/components/RolePanel';
import { useAddAction } from '@/features/shell/add-action';
import type { DashboardType } from '../schema';

const BLUE = { '--hairline-radius': '0.75rem', '--hairline-color': '#388cff' } as CSSProperties;

/**
 * "System Dashboards Type" (XD "Center Dash" 54): the dashboards box framed
 * blue and the title strip, then the types — a short chip and a 352-wide name
 * card each. Business units have one type, Management, and it is fixed
 * (decided 2026-11-21): read only, no "+" and no panel.
 */
export function DashboardTypeList({ items }: { items: DashboardType[] }) {
    const t = useTranslations('dashboardType');
    const locale = useLocale();
    const { setHideAdd } = useAddAction();
    useEffect(() => {
        setHideAdd(true);
        return () => setHideAdd(false);
    }, [setHideAdd]);

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="flex items-stretch gap-4 ps-12">
                <span className="hairline bg-surface rad-12 flex h-50 w-50 shrink-0 items-center justify-center" style={BLUE}>
                    <Icon name="nav/database" size={26} />
                </span>
                <span className="bg-surface rad-12 flex h-50 min-w-0 flex-1 items-center ps-12">
                    <span className="fz-14 text-ink font-light">{t('title')}</span>
                </span>
            </header>
            <ul className="mt-4 flex flex-col gap-4 ps-12">
                {items.map((item) => (
                    <li key={item.id} className="flex gap-4">
                        <span className="bg-surface rad-12 fz-14 text-ink flex h-50 w-50 shrink-0 items-center justify-center">
                            {item.short_name}
                        </span>
                        <span className="bg-surface rad-12 flex h-50 w-352 max-w-full items-center ps-12">
                            <span className="fz-14 text-ink truncate">{pickRoleName(item.name, locale)}</span>
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

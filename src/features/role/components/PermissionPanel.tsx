'use client';

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { ChipLine, Section } from '@/features/region/components/AddCountryDrawer';
import { permissionChip, type Permission, type Role } from '../schema';
import { pickRoleName } from './RolePanel';

const BLUE = { '--hairline-radius': '0.75rem', '--hairline-color': '#388cff' } as CSSProperties;

type Tab = 'info' | 'roles';

/**
 * The right panel of the Permissions tab: one permission of the project's
 * catalog, READ-ONLY — the project publishes its permissions and the console
 * cannot add or change them. ⓘ shows what it is (key, label in each language,
 * where it takes effect, sensitive / Root-only, status); ⚙ shows which roles
 * hold it, from the roles already on the screen.
 */
export function PermissionPanel({ permission, roles }: { permission: Permission; roles: Role[] }) {
    const t = useTranslations('rbac');
    const locale = useLocale();
    const [tab, setTab] = useState<Tab>('info');
    const label = pickRoleName(permission.label, locale) || permission.key;
    const where = permission.grantable_at ?? [];
    const holding = roles.filter((r) =>
        r.permissions.some((p) => p.key === permission.key && p.status !== 'RETIRED'),
    );
    const status =
        permission.status === 'DEPRECATED'
            ? t('perm.deprecated')
            : permission.status === 'RETIRED'
              ? t('perm.retired')
              : t('catalog.active');

    return (
        <div className="thin-scroll flex flex-1 flex-col gap-16 overflow-y-auto px-12 py-16">
            <div className="flex items-center gap-8">
                <span className="fz-14 text-ink font-medium">{permissionChip(permission.key)}</span>
                <span className="fz-14 text-ink min-w-0 flex-1 truncate">{label}</span>
                <span className="fz-10 text-muted shrink-0">{t('catalog.readOnly')}</span>
            </div>

            <div className="flex gap-6">
                {(['info', 'roles'] as const).map((id) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setTab(id)}
                        aria-pressed={tab === id}
                        aria-label={id === 'info' ? t('panel.info') : t('catalog.inRoles')}
                        style={tab === id ? BLUE : undefined}
                        className={cn(
                            'rad-12 text-ink grid h-36 w-36 place-items-center',
                            tab === id ? 'hairline' : 'text-muted',
                        )}
                    >
                        <Icon name={id === 'info' ? 'roles/info' : 'roles/gear'} size={18} />
                    </button>
                ))}
            </div>

            {tab === 'info' ? (
                <>
                    <Section title={t('catalog.key')}>
                        <span className="bg-surface rad-12 fz-14 text-ink flex h-50 items-center px-12">
                            {permission.key}
                        </span>
                    </Section>

                    <Section title={t('catalog.label')}>
                        {Object.entries(permission.label ?? {}).map(([lang, text]) => (
                            <ChipLine key={lang} phase="ready" code={lang.toUpperCase()} value={text} />
                        ))}
                    </Section>

                    <Section title={t('catalog.where')}>
                        <span className="bg-surface rad-12 fz-14 text-ink flex min-h-50 items-center px-12 py-8">
                            {where.length
                                ? where
                                      .map((g) =>
                                          ['project', 'country', 'region', 'branch'].includes(g)
                                              ? t(`perm.place.${g as 'project' | 'country' | 'region' | 'branch'}`)
                                              : g,
                                      )
                                      .join(', ')
                                : t('catalog.anywhere')}
                        </span>
                    </Section>

                    <Section title={t('catalog.details')}>
                        <div className="flex flex-wrap gap-4">
                            <Tag tone={permission.status === 'ACTIVE' ? 'plain' : 'muted'}>{status}</Tag>
                            {permission.sensitive && (
                                <Tag tone="red">
                                    <Icon name="roles/sensitive" size={12} mask />
                                    {t('perm.sensitive')}
                                </Tag>
                            )}
                            {permission.root_only && <Tag tone="plain">{t('catalog.rootOnly')}</Tag>}
                        </div>
                    </Section>
                </>
            ) : (
                <Section title={t('catalog.inRoles')}>
                    {holding.length === 0 ? (
                        <span className="fz-12 text-muted">
                            {permission.root_only ? t('catalog.rootOnlyRoles') : t('catalog.noRoles')}
                        </span>
                    ) : (
                        holding.map((r) => (
                            <div key={r.id} className="flex gap-4">
                                <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center">
                                    {r.short_name}
                                </span>
                                <span className="bg-surface rad-12 fz-14 text-ink flex h-50 min-w-0 flex-1 items-center px-12">
                                    {pickRoleName(r.name, locale)}
                                </span>
                            </div>
                        ))
                    )}
                </Section>
            )}
        </div>
    );
}

function Tag({ tone, children }: { tone: 'plain' | 'muted' | 'red'; children: React.ReactNode }) {
    return (
        <span
            className={cn(
                'bg-surface rad-12 fz-12 flex h-36 items-center gap-6 px-12',
                tone === 'plain' && 'text-ink',
                tone === 'muted' && 'text-muted',
                tone === 'red' && 'text-red-500',
            )}
        >
            {children}
        </span>
    );
}

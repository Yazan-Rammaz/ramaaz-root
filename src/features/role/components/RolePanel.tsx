'use client';

import type { CSSProperties } from 'react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { translateNameAction } from '@/features/region/ai';
import { useAutoNames } from '@/features/region/use-auto-names';
import { ChipLine, Field, Section } from '@/features/region/components/AddCountryDrawer';
import { flagEmoji, resolveFlag } from '@/features/region/mock-geo';
import { createRoleAction, deleteRoleAction, updateRoleAction } from '../actions';
import { rowLanguages, type NameLanguage, type NameRow } from '@/features/language/names';
import type { Permission, Role, RoleCountry, RoleName } from '../schema';
import { useRoleWrite } from '../use-role-write';

const BLUE = { '--hairline-radius': '0.75rem', '--hairline-color': '#388cff' } as CSSProperties;

/** A name in the interface language, else English, else whatever is there. */
export function pickRoleName(name: RoleName | undefined, locale: string): string {
    if (!name) return '';
    return name[locale]?.trim() || name.en?.trim() || Object.values(name).find((v) => v.trim()) || '';
}

type Tab = 'info' | 'permissions';

/**
 * The right panel of the roles screen (task 2026-11-05): one role, or a new
 * one. Header (short name, name, holders, delete), the country flags, and two
 * tabs — ⓘ availability + names, ⚙ permissions. Save sends the COMPLETE
 * definition; a role somebody holds asks first, because the change reaches
 * all of them. Mounted per role (keyed by the list), so its form always
 * starts from what the backend holds.
 */
export function RolePanel({
    role,
    permissions,
    countries,
    languages,
    onSaved,
    onDeleted,
    onReload,
}: {
    /** Null = a new role. */
    role: Role | null;
    permissions: Permission[];
    countries: RoleCountry[];
    /**
     * The project's languages: a role's name is offered in the same ones as
     * every name form (2026-11-08 §1) — the console accepts any language tag.
     */
    languages: NameLanguage[];
    onSaved: (role: Role) => void;
    onDeleted: (id: string) => void;
    /** The list moved underneath (another Root) — read it again. */
    onReload: () => void;
}) {
    const t = useTranslations('rbac');
    const locale = useLocale();
    const write = useRoleWrite();
    const [tab, setTab] = useState<Tab>('info');

    // ── The form, from what the backend holds ─────────────────────────────
    const [shortName, setShortName] = useState(role?.short_name ?? '');
    // Every language names can use, plus one the role's name still has text in.
    const nameLanguages = rowLanguages(languages, role?.name);
    const [names, setNames] = useState<RoleName>(() =>
        Object.fromEntries(nameLanguages.map((l) => [l.code, role?.name[l.code] ?? ''])),
    );
    // Retired keys grant nothing: shown greyed, never sent back.
    const retired = new Set((role?.permissions ?? []).filter((p) => p.status === 'RETIRED').map((p) => p.key));
    const [held, setHeld] = useState<Set<string>>(
        () => new Set((role?.permissions ?? []).filter((p) => p.status !== 'RETIRED').map((p) => p.key)),
    );
    // New roles start available everywhere (task §2).
    const [allCountries, setAllCountries] = useState(role?.all_countries ?? true);
    const [picked, setPicked] = useState<Set<string>>(() => new Set((role?.countries ?? []).map((c) => c.id)));
    const [confirm, setConfirm] = useState<'save' | 'delete' | null>(null);

    const holders = role?.holders ?? 0;
    const fields = write.result.fields ?? {};
    const edited = <T,>(set: (v: T) => void) => (v: T) => {
        set(v);
        setConfirm(null);
        write.reset();
    };

    // ── The other languages, from the English name (the AI pass) ───────────
    // The shared rule (useAutoNames): nothing on open; after the English name
    // changes, the empty and AI-filled rows; only the rows being filled
    // shimmer; the AI mark redoes them all, a language's chip just that one. A role keeps
    // its name keyed by code, so the hook sees it as rows and back.
    const en = names.en ?? '';
    const rows: NameRow[] = nameLanguages.map((l) => ({ code: l.chip, name: names[l.code] ?? '' }));
    const setRows: Dispatch<SetStateAction<NameRow[]>> = (u) =>
        setNames((n) => {
            const current = nameLanguages.map((l) => ({ code: l.chip, name: n[l.code] ?? '' }));
            const next = typeof u === 'function' ? u(current) : u;
            const out = { ...n };
            for (const r of next) {
                const lang = nameLanguages.find((l) => l.chip === r.code);
                if (lang) out[lang.code] = r.name;
            }
            return out;
        });
    const auto = useAutoNames({
        en,
        rows,
        setRows,
        ask: async (text) => ({
            translations: await translateNameAction(text, 'the name of a user role in an administration console'),
        }),
    });
    const aiPhase = auto.phase;

    function body() {
        return {
            short_name: shortName.trim(),
            name: names,
            permissions: [...held].filter((k) => !retired.has(k)),
            all_countries: allCountries,
            countries: allCountries ? [] : [...picked],
        };
    }

    async function save() {
        // A change reaches everyone holding the role: ask first.
        if (role && holders > 0 && confirm !== 'save') return setConfirm('save');
        setConfirm(null);
        const r = await write.run(() => (role ? updateRoleAction(role.id, body()) : createRoleAction(body())));
        if (r?.role) onSaved(r.role);
        else if (r?.reload) onReload();
    }

    async function remove() {
        if (!role) return;
        if (confirm !== 'delete') return setConfirm('delete');
        setConfirm(null);
        const r = await write.run(() => deleteRoleAction(role.id));
        if (r?.deleted) onDeleted(role.id);
        else if (r?.reload) onReload();
    }

    const displayName = pickRoleName(names, locale) || (role ? pickRoleName(role.name, locale) : '');
    const canSave = /^[A-Za-z0-9]{1,4}$/.test(shortName.trim()) && Object.values(names).some((v) => v.trim());

    return (
        <>
            <div className="thin-scroll flex flex-1 flex-col gap-16 overflow-y-auto px-12 py-16">
                {/* Header: short name, name, holders, delete. */}
                <div className="flex items-center gap-8">
                    <span className="fz-14 text-ink font-medium">{shortName.trim() || '—'}</span>
                    <span className="fz-14 text-ink min-w-0 flex-1 truncate">{displayName || t('newRole')}</span>
                    {role && (
                        <>
                            <span className="fz-10 text-muted shrink-0">{t('heldBy', { count: holders })}</span>
                            <button
                                type="button"
                                onClick={remove}
                                disabled={holders > 0 || write.busy}
                                aria-label={t('remove.label')}
                                title={holders > 0 ? t('remove.held', { count: holders }) : t('remove.label')}
                                className="text-muted shrink-0 p-4 hover:text-red-500 disabled:opacity-40"
                            >
                                <Icon name="roles/trash" size={14} mask />
                            </button>
                        </>
                    )}
                </div>

                {/* The project's countries — included ones framed. */}
                <div className="flex flex-wrap gap-6">
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
                                title={c.closed ? t('availability.closed', { name: label }) : label}
                                onClick={() =>
                                    edited(setPicked)(
                                        new Set(picked.has(c.id) ? [...picked].filter((x) => x !== c.id) : [...picked, c.id]),
                                    )
                                }
                                style={on ? BLUE : undefined}
                                className={cn(
                                    'bg-surface rad-12 grid h-36 min-w-36 place-items-center px-6',
                                    on && 'hairline',
                                    !on && 'opacity-50',
                                    c.closed && 'grayscale',
                                )}
                            >
                                {flag ? (
                                    <Icon name={flag.icon} width={18} height={14} />
                                ) : c.code ? (
                                    <span className="fz-16 leading-none">{flagEmoji(c.code)}</span>
                                ) : (
                                    <span className="fz-10 text-ink">{label}</span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* ⓘ / ⚙ */}
                <div className="flex gap-6">
                    {(['info', 'permissions'] as const).map((id) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setTab(id)}
                            aria-pressed={tab === id}
                            aria-label={t(`panel.${id}`)}
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
                        <Section title={t('availability.title')}>
                            <div className="bg-surface rad-12 flex flex-col gap-6 px-12 py-8">
                                <span className="fz-10 text-muted">{t('availability.all')}</span>
                                <div className="fz-12 text-ink flex gap-16">
                                    {([true, false] as const).map((all) => (
                                        <label key={String(all)} className="flex cursor-pointer items-center gap-6">
                                            <input
                                                type="radio"
                                                name="role-availability"
                                                checked={allCountries === all}
                                                onChange={() => edited(setAllCountries)(all)}
                                                className="accent-primary"
                                            />
                                            {all ? t('availability.enable') : t('availability.disable')}
                                        </label>
                                    ))}
                                </div>
                            </div>
                            {!allCountries && picked.size === 0 && (
                                <span className="fz-12 text-red-500">{t('availability.none')}</span>
                            )}
                            <FieldError message={fields.all_countries ?? fields.countries ?? countryError(fields)} />
                        </Section>

                        <Section title={t('name.title')}>
                            <div className="flex gap-4">
                                <span className="flex w-128 shrink-0 flex-col gap-4">
                                    <Field
                                        label={t('name.short')}
                                        hint={t('name.shortHint')}
                                        value={shortName}
                                        maxLength={4}
                                        onChange={edited(setShortName)}
                                    />
                                    <FieldError message={fields.short_name} />
                                </span>
                                <span className="flex min-w-0 flex-1 flex-col gap-4">
                                    <Field
                                        label={t('name.label')}
                                        value={names.en ?? ''}
                                        maxLength={80}
                                        aiPhase={aiPhase}
                                        onChange={(v) => edited(setNames)({ ...names, en: v })}
                                    />
                                    <FieldError message={fields['name.en'] ?? fields.name} />
                                </span>
                            </div>
                        </Section>

                        <Section title={t('name.translation')} phase={aiPhase} ai onAi={auto.retranslate}>
                            {nameLanguages.filter((l) => l.code !== 'en').map(({ code: l, chip, direction }) => (
                                <span key={l} className="flex flex-col gap-4">
                                    <ChipLine
                                        // Only a row the AI is filling waits on it; the rest stay editable.
                                        phase={auto.filling.has(chip) ? 'gen' : 'ready'}
                                        code={chip}
                                        dir={direction}
                                        value={names[l] ?? ''}
                                        onChip={() => auto.retranslateOne(chip)}
                                        onChange={(v) => {
                                            auto.typed(rows, rows.map((r) => (r.code === chip ? { ...r, name: v } : r)));
                                            edited(setNames)({ ...names, [l]: v });
                                        }}
                                    />
                                    <FieldError message={fields[`name.${l}`]} />
                                </span>
                            ))}
                        </Section>
                    </>
                ) : (
                    <PermissionList
                        permissions={permissions}
                        held={held}
                        retired={[...retired]}
                        onToggle={(key) =>
                            edited(setHeld)(new Set(held.has(key) ? [...held].filter((k) => k !== key) : [...held, key]))
                        }
                        error={fields.permissions}
                    />
                )}
            </div>

            {/* Pinned: save, or the confirmation it asks for. */}
            <div className="flex shrink-0 flex-col gap-8 p-24 pt-0">
                {confirm && (
                    <span className="fz-12 text-ink text-center">
                        {confirm === 'save'
                            ? t('save.held', { count: holders })
                            : t('remove.confirm', { name: displayName, short: shortName.trim() })}
                    </span>
                )}
                <div className="flex gap-8">
                    {confirm && (
                        <button
                            type="button"
                            onClick={() => setConfirm(null)}
                            disabled={write.busy}
                            className="bg-surface fz-14 rad-12 text-ink h-50 w-110 shrink-0 font-medium disabled:opacity-50"
                        >
                            {t('save.cancel')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={confirm === 'delete' ? remove : save}
                        disabled={(!canSave && confirm !== 'delete') || write.busy}
                        aria-busy={write.busy}
                        className={cn(
                            'fz-14 rad-12 flex h-50 flex-1 items-center justify-center font-medium text-white disabled:opacity-50',
                            confirm === 'delete' ? 'bg-red-500' : 'bg-primary',
                        )}
                    >
                        {confirm === 'delete'
                            ? t('remove.yes')
                            : confirm === 'save'
                              ? t('save.confirm')
                              : role
                                ? t('save.edit')
                                : t('save.add')}
                    </button>
                </div>
                <FormError message={write.result.error} attempt={write.result} />
            </div>
        </>
    );
}

/** The first `countries[i]` refusal, if any (`countries[0]`: not a country of this project). */
function countryError(fields: Record<string, string>): string | undefined {
    return Object.entries(fields).find(([k]) => k.startsWith('countries['))?.[1];
}

function FieldError({ message }: { message?: string }) {
    return message ? <span className="fz-10 text-red-500">{message}</span> : null;
}

/**
 * The ⚙ tab: one checkbox per permission the project publishes (root-only and
 * retired ones never reach here), with its label in the interface language,
 * a mark for sensitive ones, "being withdrawn" for deprecated ones and where
 * it takes effect. Keys the role holds that have since been retired are
 * listed greyed and can't be picked — they are dropped on save.
 */
function PermissionList({
    permissions,
    held,
    retired,
    onToggle,
    error,
}: {
    permissions: Permission[];
    held: Set<string>;
    retired: string[];
    onToggle: (key: string) => void;
    error?: string;
}) {
    const t = useTranslations('rbac.perm');
    const locale = useLocale();
    if (permissions.length === 0 && retired.length === 0) {
        return <span className="fz-12 text-muted">{t('empty')}</span>;
    }
    return (
        <div className="flex flex-col gap-4">
            {permissions.map((p) => {
                const where = (p.grantable_at ?? []).filter((g) => g !== 'project');
                return (
                    <label
                        key={p.key}
                        className="bg-surface rad-12 flex min-h-50 cursor-pointer items-center gap-8 px-12 py-6"
                    >
                        <input
                            type="checkbox"
                            checked={held.has(p.key)}
                            onChange={() => onToggle(p.key)}
                            className="accent-primary shrink-0"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="fz-12 text-ink flex items-center gap-6">
                                {pickRoleName(p.label, locale) || p.key}
                                {p.sensitive && (
                                    <span title={t('sensitive')} className="text-red-500">
                                        <Icon name="roles/sensitive" size={12} mask />
                                    </span>
                                )}
                            </span>
                            <span className="fz-10 text-muted">
                                {[
                                    p.key,
                                    p.status === 'DEPRECATED' ? t('deprecated') : null,
                                    where.length
                                        ? t('where', {
                                              places: where
                                                  .map((g) =>
                                                      ['country', 'region', 'branch'].includes(g)
                                                          ? t(`place.${g as 'country' | 'region' | 'branch'}`)
                                                          : g,
                                                  )
                                                  .join(', '),
                                          })
                                        : null,
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </span>
                        </span>
                    </label>
                );
            })}
            {retired.map((key) => (
                <label key={key} className="bg-surface rad-12 flex min-h-50 items-center gap-8 px-12 opacity-50">
                    <input type="checkbox" checked={false} disabled className="shrink-0" />
                    <span className="fz-12 text-muted">
                        {key} · {t('retired')}
                    </span>
                </label>
            ))}
            {error && <span className="fz-10 text-red-500">{error}</span>}
        </div>
    );
}

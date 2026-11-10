'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { useAddAction } from '@/features/shell/add-action';
import { flagEmoji, resolveFlag } from '@/features/region/mock-geo';
import type { AccessSettings, AdminStage, BusinessAdmin, Dashboard, StructureNode } from '../schema';
import { AddAdminButton, AddAdminSheet, AdminFiles, AdminRow, LoginInfo, ReviewSheet, type NewAdmin } from './Admins';
import { AccessForm, DataSettings } from './Settings';
import { Choice, ChoiceBox, FlagStrip, InfoField, OneOf, PanelTitle, TabStrip } from './parts';

/**
 * Business Work Structure (XD "Root Dashboard home page" 9–43): the tree of
 * businesses on the start side — only "Main Business Management" is open to
 * this administrator, the rest shows blurred — and, on the end side, the
 * selected business's dashboard: ⓘ what it is, ⚙ how it is reached, its
 * business admins (Login Info) and the project data it gets (Data Setting).
 * The navbar "+" adds a business management at once (it joins the tree under
 * the main one, open on ⓘ); its business admins are a step inside it, from
 * Login Info. An
 * admin opens their own panel; adding one and reviewing their files open as
 * sheets over it. The navbar's Close goes back one step.
 *
 * ⚠️ Design only — everything is mocked (`api.ts`) and stays on the screen
 * until a reload.
 */

const PANEL_TABS = ['info', 'settings', 'login', 'data'] as const;
type PanelTab = (typeof PANEL_TABS)[number];
const PANEL_ICON: Record<PanelTab, string> = {
    info: 'roles/info',
    settings: 'roles/gear',
    login: 'work/admin',
    data: 'work/data',
};
const ADMIN_TABS = ['info', 'settings', 'log', 'files'] as const;
type AdminTab = (typeof ADMIN_TABS)[number];
const ADMIN_ICON: Record<AdminTab, string> = {
    info: 'roles/info',
    settings: 'roles/gear',
    log: 'work/clock',
    files: 'work/link',
};

type View =
    | { kind: 'dashboard' }
    | { kind: 'addAdmin' }
    | { kind: 'review'; id: string }
    | { kind: 'admin'; id: string };

export function WorkStructureScreen({
    tree: initialTree,
    dashboard: initial,
    countries,
}: {
    tree: StructureNode[];
    dashboard: Dashboard;
    /** The project's country codes — the flag strips. */
    countries: string[];
}) {
    const t = useTranslations('work');
    const [tree, setTree] = useState(initialTree);
    // Every business management's dashboard, by its node in the tree.
    const [dashboards, setDashboards] = useState<Record<string, Dashboard>>({ [initial.id]: initial });
    // Nothing is open until a business is picked in the tree (or "+" adds one).
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const dashboard = selectedId ? dashboards[selectedId] : undefined;
    const [tab, setTab] = useState<PanelTab>('info');
    const [view, setView] = useState<View>({ kind: 'dashboard' });
    // A picked photo stays in the browser (an object URL) — design only.
    const [photos, setPhotos] = useState<Record<string, string>>({});
    const patch = (p: Partial<Dashboard>) =>
        selectedId && setDashboards((all) => ({ ...all, [selectedId]: { ...all[selectedId], ...p } }));

    // The navbar "+" (`?add=business`) adds a business management at once —
    // there is no form to fill first (XD frame 9 is its first step): it joins
    // the tree under the main one and opens on ⓘ, and every later step is
    // its own tabs, Login Info included (that is where its admins are added).
    const router = useRouter();
    const adding = useSearchParams().get('add') === 'business';
    // Added once per press of "+": the URL is cleared right after (below).
    const [addSeen, setAddSeen] = useState(false);
    if (adding && !addSeen) {
        setAddSeen(true);
        const id = `business-${Object.keys(dashboards).length + 1}`;
        const created: Dashboard = { ...initial, id, admins: [] };
        setDashboards((all) => ({ ...all, [id]: created }));
        setTree((nodes) =>
            nodes.map((root, i) =>
                i === 0
                    ? { ...root, children: [...root.children, { id, name: created.title, icon: created.icon, children: [] }] }
                    : root,
            ),
        );
        setSelectedId(id);
        setTab('info');
        setView({ kind: 'dashboard' });
    }
    if (!adding && addSeen) setAddSeen(false);
    useEffect(() => {
        if (adding) router.replace('/work-structure');
    }, [adding, router]);

    const advance = useCallback(
        (id: string, stage: AdminStage) =>
            setDashboards((all) => {
                const owner = Object.values(all).find((d) => d.admins.some((a) => a.id === id));
                if (!owner) return all;
                return {
                    ...all,
                    [owner.id]: { ...owner, admins: owner.admins.map((a) => (a.id === id ? { ...a, stage } : a)) },
                };
            }),
        [],
    );

    function addAdmin(a: NewAdmin) {
        const id = `admin-${Date.now()}`;
        const admin: BusinessAdmin = {
            id,
            short: 'BA',
            name: a.name.trim(),
            phone: a.phone.trim(),
            ips: a.ips,
            mac: a.mac,
            device: a.device,
            secretWords: a.secretWords,
            addedBy: 'Mohamad Katmawi',
            approvedBy: 'Yasser Omran',
            addedAt: new Date().toLocaleDateString(),
            stage: 'approval',
            log: [],
            // What the sign-in would collect — mock values from the design.
            kyc: {
                idType: 'Personal Identity ID',
                country: 'Syria',
                name: a.name.trim(),
                nationalNumber: '09982111123332',
                birthday: '01.01.1999',
            },
        };
        if (a.photo) setPhotos((p) => ({ ...p, [id]: a.photo! }));
        patch({ admins: [...(dashboard?.admins ?? []), admin] });
        setTab('login');
        setView({ kind: 'dashboard' });
    }

    // The navbar "+" adds a business management; its Close takes a sheet or
    // an admin's panel back to the dashboard.
    const { setHref, setOnClose } = useAddAction();
    useEffect(() => {
        setHref('/work-structure?add=business');
        return () => setHref(null);
    }, [setHref]);
    // Close goes back one step: a sheet or an admin to the dashboard, the
    // dashboard to nothing open (the "+" panel closes through the URL).
    useEffect(() => {
        if (view.kind !== 'dashboard') {
            setOnClose(() => setView({ kind: 'dashboard' }));
            return () => setOnClose(null);
        }
        if (!selectedId) return;
        setOnClose(() => setSelectedId(null));
        return () => setOnClose(null);
    }, [view.kind, selectedId, setOnClose]);

    const admin =
        view.kind === 'admin' || view.kind === 'review' ? dashboard?.admins.find((a) => a.id === view.id) : undefined;
    // The tree's closed branches blur only while a panel is open beside it.
    const panelOpen = dashboard != null;

    return (
        <div className="flex h-full gap-12">
            <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto ps-12">
                <Tree
                    nodes={tree}
                    depth={0}
                    selectedId={selectedId}
                    blurLocked={panelOpen}
                    onSelect={(id) => {
                        if (!dashboards[id]) return;
                        setSelectedId(id);
                        setView({ kind: 'dashboard' });
                    }}
                />
            </div>

            {panelOpen && (
            <aside className="relative flex h-full w-430 max-w-full shrink-0 flex-col gap-4 overflow-hidden p-8">
                <DashedFrame radius={12} color="#c3c3c3" />
                {!dashboard ? null : view.kind === 'admin' && admin ? (
                    <AdminPanel admin={admin} photo={photos[admin.id]} countries={countries} access={dashboard.access} />
                ) : (
                    <>
                        <PanelHeader dashboard={dashboard} tab={tab} addingAdmin={view.kind === 'addAdmin'} />
                        {view.kind === 'dashboard' ? (
                            <>
                                <FlagStrip codes={countries} framed={tab === 'info' || tab === 'settings'} />
                                <TabStrip
                                    tabs={PANEL_TABS}
                                    value={tab}
                                    icon={(id) => PANEL_ICON[id]}
                                    label={(id) => t(`tabs.${id}`)}
                                    onChange={setTab}
                                />
                                <div className="thin-scroll flex flex-1 flex-col gap-8 overflow-y-auto px-4 pt-4">
                                    {tab === 'info' && <InfoTab dashboard={dashboard} onChange={patch} />}
                                    {tab === 'settings' && (
                                        <AccessForm value={dashboard.access} onChange={(access) => patch({ access })} scope="dashboard" />
                                    )}
                                    {tab === 'login' && (
                                        <LoginInfo
                                            link={dashboard.link}
                                            admins={dashboard.admins}
                                            photos={photos}
                                            onAdvance={advance}
                                            onOpenAdmin={(id) => setView({ kind: 'admin', id })}
                                            onReview={(id) => setView({ kind: 'review', id })}
                                        />
                                    )}
                                    {tab === 'data' && <DataSettings data={dashboard.data} onUpdate={(data) => patch({ data })} />}
                                </div>
                                {tab === 'login' && <AddAdminButton onClick={() => setView({ kind: 'addAdmin' })} />}
                            </>
                        ) : (
                            // A sheet over the dimmed dashboard (frames 20, 27).
                            <div className="flex flex-1 flex-col bg-black/70 pt-48">
                                {view.kind === 'addAdmin' ? (
                                    <AddAdminSheet onAdd={addAdmin} onClose={() => setView({ kind: 'dashboard' })} />
                                ) : (
                                    admin && (
                                        <ReviewSheet
                                            admin={admin}
                                            photo={photos[admin.id]}
                                            onClose={() => setView({ kind: 'dashboard' })}
                                            onApprove={() => {
                                                advance(admin.id, 'active');
                                                setView({ kind: 'dashboard' });
                                            }}
                                        />
                                    )
                                )}
                            </div>
                        )}
                    </>
                )}
            </aside>
            )}
        </div>
    );
}

/** "🌍 Main Company | Projects Management | {tab} | All" — or "Add Business Admin" while adding one. */
function PanelHeader({ dashboard, tab, addingAdmin }: { dashboard: Dashboard; tab: PanelTab; addingAdmin: boolean }) {
    const t = useTranslations('work');
    return (
        <span className="bg-surface rad-12 fz-12 text-ink flex h-50 shrink-0 items-center gap-6 px-8">
            {addingAdmin ? (
                <span className="flex-1 text-center">{t('admins.add')}</span>
            ) : (
                <>
                    <Icon name={dashboard.icon} size={14} />
                    <span className="truncate">
                        {dashboard.title}
                        {tab !== 'info' && (
                            <>
                                {' | '}
                                <span className="font-medium">{t(`header.${tab}`)}</span> | {t('header.all')}
                            </>
                        )}
                    </span>
                </>
            )}
        </span>
    );
}

/* ───────────────────────────── Tree ───────────────────────────── */

/**
 * The structure tree. Each level steps in toward the end side; a node with a
 * dashboard opens it (the open one framed blue); one this administrator
 * can't open yet is blurred and inert, as in the design.
 */
function Tree({
    nodes,
    depth,
    selectedId,
    onSelect,
    blurLocked,
}: {
    nodes: StructureNode[];
    depth: number;
    selectedId: string | null;
    onSelect: (id: string) => void;
    /** A panel is open beside the tree: what can't be opened blurs. */
    blurLocked: boolean;
}) {
    return (
        <>
            {nodes.map((n) => {
                const on = n.id === selectedId;
                return (
                    <div key={n.id} className="flex flex-col gap-4">
                        <button
                            type="button"
                            onClick={() => onSelect(n.id)}
                            disabled={n.locked}
                            className={cn(
                                'flex items-center gap-4 text-start',
                                n.locked && 'pointer-events-none select-none',
                                n.locked && blurLocked && 'blur-[0.125rem]',
                            )}
                            style={{ paddingInlineStart: `${depth > 0 ? (depth - 1) * 2.25 + 2.25 : 0}rem` } as CSSProperties}
                        >
                            <span className={cn('rad-12 grid h-50 w-50 shrink-0 place-items-center', depth === 0 && 'bg-surface')}>
                                <NodeIcon node={n} />
                            </span>
                            <span
                                className={cn(
                                    'bg-surface rad-12 fz-12 text-ink flex h-50 min-w-0 flex-1 items-center px-12',
                                    (on || depth === 0) && 'hairline',
                                )}
                                style={
                                    {
                                        '--hairline-radius': '0.75rem',
                                        '--hairline-color': on ? '#388cff' : '#e3e3e3',
                                    } as CSSProperties
                                }
                            >
                                <span className="truncate">{n.name}</span>
                            </span>
                        </button>
                        {n.children.length > 0 && (
                            <Tree
                                nodes={n.children}
                                depth={depth + 1}
                                selectedId={selectedId}
                                onSelect={onSelect}
                                blurLocked={blurLocked}
                            />
                        )}
                    </div>
                );
            })}
        </>
    );
}

function NodeIcon({ node }: { node: StructureNode }) {
    if (node.flag) {
        const flag = resolveFlag(node.flag);
        return flag ? <Icon name={flag.icon} width={22} height={16} /> : <span className="fz-18">{flagEmoji(node.flag)}</span>;
    }
    return node.icon ? <Icon name={node.icon} size={26} /> : null;
}

/* ───────────────────────────── ⓘ ───────────────────────────── */

/** What the dashboard is: where it is available, how many admins, its type, work type and language (frame 9). */
function InfoTab({ dashboard, onChange }: { dashboard: Dashboard; onChange: (p: Partial<Dashboard>) => void }) {
    const t = useTranslations('work.info');
    return (
        <div className="flex flex-col gap-8">
            <PanelTitle>{t('availability')}</PanelTitle>
            <ChoiceBox label={t('countries')}>
                <OneOf
                    options={['enable', 'disable'] as const}
                    value={dashboard.allCountries ? 'enable' : 'disable'}
                    label={(o) => t(o)}
                    onChange={(o) => onChange({ allCountries: o === 'enable' })}
                />
            </ChoiceBox>
            <InfoField label={t('seats')} value={dashboard.adminSeats} />
            <PanelTitle icon="nav/database">{t('type')}</PanelTitle>
            <ShortRow short={dashboard.type.short} name={dashboard.type.name} />
            <PanelTitle icon="business/corporate">{t('workType')}</PanelTitle>
            <ShortRow short={dashboard.workType.short} name={dashboard.workType.name} />
            <span className="fz-12 text-muted">{t('language', { count: 1 })}</span>
            <div className="flex gap-6">
                {dashboard.languages.map((code) => (
                    <button
                        key={code}
                        type="button"
                        onClick={() => onChange({ language: code })}
                        aria-pressed={dashboard.language === code}
                        className={cn('rad-10 grid h-34 w-34 place-items-center', dashboard.language === code && 'hairline')}
                        style={{ '--hairline-radius': '0.625rem', '--hairline-color': '#388cff' } as CSSProperties}
                    >
                        <span className="bg-ink rad-5 fz-10 grid h-20 w-24 place-items-center font-semibold text-white">{code}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function ShortRow({ short, name }: { short: string; name: string }) {
    return (
        <div className="flex gap-4">
            <span className="bg-surface rad-12 fz-12 text-ink grid h-50 w-50 shrink-0 place-items-center">{short}</span>
            <span className="bg-surface rad-12 fz-12 text-ink flex h-50 flex-1 items-center px-12">{name}</span>
        </div>
    );
}

/* ───────────────────────────── An admin ───────────────────────────── */

/** One business admin's own panel (frames 34–37): info, settings, log, and the files their sign-in captured. */
function AdminPanel({
    admin,
    photo,
    countries,
    access: dashboardAccess,
}: {
    admin: BusinessAdmin;
    photo?: string;
    countries: string[];
    access: AccessSettings;
}) {
    const t = useTranslations('work.admin');
    const [tab, setTab] = useState<AdminTab>('info');
    // An admin's access starts from the dashboard's, and may narrow it.
    const [access, setAccess] = useState(dashboardAccess);
    const [allCountries, setAllCountries] = useState(true);

    return (
        <>
            <AdminRow admin={admin} photo={photo} />
            <FlagStrip codes={countries} />
            <TabStrip tabs={ADMIN_TABS} value={tab} icon={(id) => ADMIN_ICON[id]} label={(id) => t(`tabs.${id}`)} onChange={setTab} />
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto px-4 pt-4">
                {tab === 'info' && (
                    <>
                        <PanelTitle>{t('info', { name: admin.name })}</PanelTitle>
                        <InfoField label={t('name')} value={admin.name} onEdit={() => {}} editLabel={t('edit')} />
                        <InfoField label={t('phone')} value={admin.phone} onEdit={() => {}} editLabel={t('edit')} />
                        <InfoField label={t('secret')} value={`"${admin.secretWords}"`} />
                        <InfoField label={t('addedBy')} value={admin.addedBy} />
                        <InfoField label={t('approvedBy')} value={admin.approvedBy ?? '—'} />
                        <InfoField label={t('addedAt')} value={admin.addedAt} />
                    </>
                )}
                {tab === 'settings' && (
                    <>
                        <PanelTitle>{t('availability', { name: admin.name })}</PanelTitle>
                        <ChoiceBox label={t('countries')}>
                            <div className="flex gap-16">
                                <Choice on={allCountries} label={t('enable')} onChange={() => setAllCountries(true)} />
                                <Choice on={!allCountries} label={t('disable')} onChange={() => setAllCountries(false)} />
                            </div>
                        </ChoiceBox>
                        <AccessForm value={access} onChange={setAccess} scope="admin" />
                    </>
                )}
                {tab === 'log' && <PanelTitle>{t('log', { name: admin.name })}</PanelTitle>}
                {tab === 'files' && (
                    <>
                        <PanelTitle>{t('info', { name: admin.name })}</PanelTitle>
                        <AdminFiles admin={admin} photo={photo} />
                        <span className="bg-surface rad-12 fz-10 text-ink flex h-36 items-center justify-between px-12">
                            <span className="font-semibold">ramaaztech</span>
                            <span>{admin.addedAt}</span>
                        </span>
                    </>
                )}
            </div>
        </>
    );
}

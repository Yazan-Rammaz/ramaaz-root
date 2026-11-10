'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import type { AccessSettings, DataGroup, DataOption, DataTab } from '../schema';
import { DATA_TABS } from '../schema';
import { Choice, ChoiceBox, OneOf, PanelTitle, TabStrip } from './parts';

/*
 * The settings a dashboard — or one admin on it — is reached with (XD frames
 * 10–11, 35), and the project data it is given (frames 38–43).
 * ⚠️ Design only: changes stay on the screen until a reload.
 */

const CONDITIONS = ['regions', 'ip', 'mac', 'device', 'timeframe'] as const;

/** One yes/no with its follow-up choice indented under it (shown only on Yes). */
/** The follow-up choices a yes/no can carry. */
type Follow = "contract1" | "contract2" | "type1" | "type2";

function YesNo<T extends Follow>({
    label,
    value,
    onChange,
    options,
    which,
    onWhich,
}: {
    label: string;
    value: boolean;
    onChange: (v: boolean) => void;
    options?: readonly T[];
    which?: T;
    onWhich?: (v: T) => void;
}) {
    const t = useTranslations('work.access');
    return (
        <ChoiceBox label={label}>
            <OneOf options={['yes', 'no'] as const} value={value ? 'yes' : 'no'} label={(o) => t(o)} onChange={(o) => onChange(o === 'yes')} />
            {value && options && which && onWhich && (
                <div className="ps-12">
                    <OneOf options={options} value={which} label={(o) => t(o as Follow)} onChange={onWhich} />
                </div>
            )}
        </ChoiceBox>
    );
}

/**
 * Access settings: how it is reached (browser or app; desktop or mobile web,
 * and which browsers), on what conditions (with the allowed IPs when Specific
 * IP is on). `scope` "dashboard" adds the link type and the first-login /
 * before-login settings; "admin" adds the after-login timeframes.
 */
export function AccessForm({
    value,
    onChange,
    scope,
}: {
    value: AccessSettings;
    onChange: (v: AccessSettings) => void;
    scope: 'dashboard' | 'admin';
}) {
    const t = useTranslations('work.access');
    const set = <K extends keyof AccessSettings>(k: K, v: AccessSettings[K]) => onChange({ ...value, [k]: v });
    const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
    const [afterLogin, setAfterLogin] = useState({ timeframe: false, signOut: false });

    return (
        <div className="flex flex-col gap-6">
            <PanelTitle>{t('title')}</PanelTitle>
            <ChoiceBox label={t('method')}>
                <OneOf options={['browser', 'application'] as const} value={value.method} label={(o) => t(o)} onChange={(o) => set('method', o)} />
            </ChoiceBox>
            <ChoiceBox label={t('model')}>
                <Choice on={value.model === 'desktop'} label={t('desktop')} onChange={() => set('model', 'desktop')} />
                <Choice on={value.model === 'mobile'} label={t('mobile')} onChange={() => set('model', 'mobile')} />
                {value.model === 'mobile' && (
                    <div className="flex gap-16 ps-12">
                        {(['chrome', 'safari'] as const).map((b) => (
                            <Choice
                                key={b}
                                on={value.browsers.includes(b)}
                                icon={`work/${b}`}
                                label={t(b)}
                                onChange={() => set('browsers', toggle(value.browsers, b))}
                            />
                        ))}
                    </div>
                )}
            </ChoiceBox>
            <ChoiceBox
                label={`${t('conditions')} | ${value.conditions.length ? t('conditionsCount', { count: value.conditions.length }) : t('noConditions')}`}
            >
                {CONDITIONS.map((c) => (
                    <div key={c} className="flex flex-col gap-6">
                        <Choice on={value.conditions.includes(c)} label={t(`condition.${c}`)} onChange={() => set('conditions', toggle(value.conditions, c))} />
                        {c === 'ip' && value.conditions.includes('ip') && (
                            <label className="bg-background rad-12 flex flex-col gap-4 px-12 py-8">
                                <span className="fz-10 text-muted">{t('ipAccess')}</span>
                                <textarea
                                    value={value.ips}
                                    onChange={(e) => set('ips', e.target.value)}
                                    rows={3}
                                    className="fz-12 text-ink w-full resize-none bg-transparent outline-none"
                                />
                            </label>
                        )}
                    </div>
                ))}
            </ChoiceBox>

            {scope === 'dashboard' ? (
                <>
                    <ChoiceBox label={t('linkType')}>
                        <OneOf options={['permalink', 'type2', 'type3'] as const} value={value.linkType} label={(o) => t(o)} onChange={(o) => set('linkType', o)} />
                    </ChoiceBox>
                    <PanelTitle>{t('firstLogin')}</PanelTitle>
                    <YesNo
                        label={t('contract')}
                        value={value.contract.required}
                        onChange={(v) => set('contract', { ...value.contract, required: v })}
                        options={['contract1', 'contract2'] as const}
                        which={value.contract.which}
                        onWhich={(w) => set('contract', { ...value.contract, which: w })}
                    />
                    <YesNo
                        label={t('verification')}
                        value={value.verification.required}
                        onChange={(v) => set('verification', { ...value.verification, required: v })}
                        options={['type1', 'type2'] as const}
                        which={value.verification.which}
                        onWhich={(w) => set('verification', { ...value.verification, which: w })}
                    />
                    <PanelTitle>{t('beforeLogin')}</PanelTitle>
                    <ChoiceBox label={t('loginType')}>
                        <OneOf options={['root', 'management'] as const} value={value.loginType} label={(o) => t(o)} onChange={(o) => set('loginType', o)} />
                    </ChoiceBox>
                    <YesNo label={t('approveType')} value={value.approve} onChange={(v) => set('approve', v)} />
                </>
            ) : (
                <>
                    <PanelTitle>{t('afterLogin')}</PanelTitle>
                    <YesNo label={t('timeframeAfter')} value={afterLogin.timeframe} onChange={(v) => setAfterLogin((a) => ({ ...a, timeframe: v }))} />
                    <YesNo label={t('timeframeSignOut')} value={afterLogin.signOut} onChange={(v) => setAfterLogin((a) => ({ ...a, signOut: v }))} />
                </>
            )}
        </div>
    );
}

/* ──────────────────────────── Data Setting ──────────────────────────── */

const DATA_ICON: Record<DataTab, string> = {
    regions: 'nav/countries',
    currencies: 'nav/currencies',
    structure: 'work/structure',
    rbac: 'nav/hierarchy',
    business: 'nav/business',
    legal: 'work/legal',
};

/** A pick and, under it, its own picks: turning one off turns its children off; turning a child on turns it on. */
function OptionTree({ options, onChange, green }: { options: DataOption[]; onChange: (o: DataOption[]) => void; green?: boolean }) {
    const setAll = (o: DataOption, on: boolean): DataOption => ({ ...o, on, children: o.children?.map((c) => setAll(c, on)) });
    return (
        <div className="flex flex-col gap-6">
            {options.map((o, i) => (
                <div key={o.id} className="flex flex-col gap-6">
                    <Choice
                        on={o.on}
                        label={o.label}
                        tint={green && o.children ? 'green' : undefined}
                        onChange={() => onChange(options.map((x, j) => (j === i ? setAll(x, !x.on) : x)))}
                    />
                    {o.children && o.on && (
                        <div className="ps-12">
                            <OptionTree
                                options={o.children}
                                onChange={(children) =>
                                    onChange(options.map((x, j) => (j === i ? { ...x, children, on: x.on || children.some((c) => c.on) } : x)))
                                }
                            />
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

/** Dashboard Data Setting: six kinds of project data, each a tree of picks, saved with Update. */
export function DataSettings({ data, onUpdate }: { data: Record<DataTab, DataGroup[]>; onUpdate: (d: Record<DataTab, DataGroup[]>) => void }) {
    const t = useTranslations('work.data');
    const [tab, setTab] = useState<DataTab>('regions');
    const [draft, setDraft] = useState(data);
    const dirty = draft !== data;

    return (
        <div className="flex flex-1 flex-col gap-6">
            <PanelTitle>{t('title')}</PanelTitle>
            <TabStrip
                tabs={DATA_TABS}
                value={tab}
                icon={(id) => DATA_ICON[id]}
                label={(id) => t(`tabs.${id}`)}
                onChange={setTab}
                className="bg-transparent ps-0"
            />
            <div className="flex flex-1 flex-col gap-8">
                {draft[tab].map((g, gi) => (
                    <div key={g.id} className="flex flex-col gap-6">
                        <PanelTitle icon={g.icon}>{g.title}</PanelTitle>
                        <ChoiceBox>
                            <OptionTree
                                options={g.options}
                                green={tab === 'regions'}
                                onChange={(options) =>
                                    setDraft((d) => ({ ...d, [tab]: d[tab].map((x, j) => (j === gi ? { ...x, options } : x)) }))
                                }
                            />
                        </ChoiceBox>
                    </div>
                ))}
            </div>
            <button
                type="button"
                onClick={() => onUpdate(draft)}
                disabled={!dirty}
                // 406 × 50, #3066cc, radius 12 (XD).
                className="bg-primary rad-12 fz-12 mx-auto flex h-50 w-406 max-w-full shrink-0 items-center justify-center gap-6 text-white disabled:opacity-60"
            >
                <Icon name="work/update" size={14} mask />
                {t('update')}
            </button>
        </div>
    );
}

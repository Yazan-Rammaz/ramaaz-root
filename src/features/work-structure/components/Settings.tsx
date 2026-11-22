'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { pickName } from '../timeline';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { saveDataSettingsAction, saveLevelRolesAction, savePolicyAction } from '../actions';
import type {
    ContractTemplate,
    DataGroup,
    DataOption,
    DataSettings as DataSettingsValue,
    DataTab,
    GrantRole,
    Level,
    LevelRoles,
    OwnPolicy,
    Policy,
    PolicyInput,
    RdbSettings,
    SettingsInput,
    SettingsItem,
    SettingsList,
    WeekDay,
} from '../schema';
import { DATA_TABS, LINK_TYPES, SETTINGS_LISTS, type LinkType } from '../schema';
import { useWorkWrite } from '../use-work-write';
import { Choice, ChoiceBox, InfoField, OneOf, PanelTitle, TabStrip } from './parts';

/*
 * The ⚙ tab of a level, exactly as XD work structure 3 (and its scrolled part)
 * draws it, and the project data it is given (frames 21–25, RDB's settings).
 *
 * Gone, because the backend cannot enforce them (2026-11-15-design-rules.md):
 * Access Method, Access Model and Access Conditions.
 *
 * Wired to the level's sign-in policy (console-api.md §5.14) — saved the
 * moment a choice is picked, since the design has no Update button here:
 *   Request Contract  → require_contract + contract_types (Contract 1/2 = BUSINESS_ADMIN_1/_2)
 *   Verification User → require_face (Type 1) / + require_id_document (Type 2)
 *   Approve Type      → require_first_login_approval
 * A choice the level above already requires is shown on Yes and locked.
 *
 *   Link Type         → link_type (Permalink = PERMALINK, Type 2 = TOKEN)
 *   Private code timer → private_code_minutes (Minute only)
 *
 * Fixed, nothing to save (decided 2026-11-21): Login Type is Management, and
 * "send via" is WhatsApp, the only channel Get Started has.
 */

/** A yes/no box with its follow-up choice indented under it, shown on Yes. */
function YesNoBox<T extends string>({
    label,
    value,
    onChange,
    locked,
    options,
    which,
    onWhich,
    whichLabel,
    disabled,
}: {
    label: string;
    value: boolean;
    onChange: (v: boolean) => void;
    /** Required by the level above: Yes, and it cannot be turned off here. */
    locked?: boolean;
    options?: readonly T[];
    which?: T;
    onWhich?: (v: T) => void;
    whichLabel?: (v: T) => string;
    disabled?: boolean;
}) {
    const t = useTranslations('work.access');
    return (
        <ChoiceBox label={label}>
            <div className="flex gap-16">
                <Choice on={value} label={t('yes')} disabled={disabled} onChange={() => onChange(true)} />
                <Choice on={!value} label={t('no')} disabled={disabled || locked} onChange={() => onChange(false)} />
            </div>
            {value && options && options.length > 0 && onWhich && (
                <div className="flex flex-wrap gap-x-16 gap-y-6 ps-12">
                    {options.map((o) => (
                        <Choice key={o} on={which === o} label={whichLabel ? whichLabel(o) : o} disabled={disabled} onChange={() => onWhich(o)} />
                    ))}
                </div>
            )}
        </ChoiceBox>
    );
}

/**
 * The level's own policy as `PUT` takes it — EVERY field, `null` for
 * "inherit": a field left out would go back to inherit. ⓘ and ⚙ edit the same
 * settings and both save through this.
 */
export function toInput(own: OwnPolicy): PolicyInput {
    return {
        dashboard: 'MANAGEMENT',
        require_contract: own.require_contract ?? null,
        contract_types: own.contract_types?.length ? own.contract_types : null,
        require_face: own.require_face ?? null,
        require_id_document: own.require_id_document ?? null,
        require_first_login_approval: own.require_first_login_approval ?? null,
        languages: own.languages?.length ? own.languages : null,
        // Only when one is picked: staging rejects a field it does not know yet
        // (default_language is built, not deployed), and left out it inherits anyway.
        ...(own.default_language ? { default_language: own.default_language } : {}),
        max_admins: own.max_admins ?? null,
        // Like default_language: only when set, until staging knows the fields.
        ...(own.link_type === 'TOKEN' || own.link_type === 'PERMALINK' ? { link_type: own.link_type } : {}),
        ...(own.private_code_minutes ? { private_code_minutes: own.private_code_minutes } : {}),
        allowed_countries: own.allowed_countries?.length ? own.allowed_countries : null,
        allowed_ips: own.allowed_ips?.length ? own.allowed_ips : null,
        sign_in_hours: own.sign_in_hours
            ? {
                  timezone: own.sign_in_hours.timezone,
                  days: own.sign_in_hours.days as WeekDay[],
                  from: own.sign_in_hours.from,
                  to: own.sign_in_hours.to,
              }
            : null,
        max_session_minutes: own.max_session_minutes ?? null,
    };
}

/** The ⚙ tab of the head office (`level` null) or a unit — XD work structure 3. */
export function SettingsForm({ level, policy, templates }: { level: Level; policy: Policy | null; templates: ContractTemplate[] }) {
    const t = useTranslations('work.access');
    const tw = useTranslations('work');
    const write = useWorkWrite();
    // The level's own settings as last saved, updated on each pick so the next
    // save sends the whole of them (PUT replaces).
    const [own, setOwn] = useState<OwnPolicy>(() => policy?.own ?? {});
    const [seen, setSeen] = useState(policy);
    if (policy !== seen) {
        setSeen(policy);
        setOwn(policy?.own ?? {});
    }
    // The timer's Yes before any minutes are typed; the minutes being typed.
    const [timerAsked, setTimerAsked] = useState(false);
    const [minutes, setMinutes] = useState<string | null>(null);

    const inh = policy?.inherited;
    const editable = !!policy?.may_edit && !write.busy;

    function save(patch: Partial<OwnPolicy>) {
        const next = { ...own, ...patch };
        setOwn(next);
        void write.run(() => savePolicyAction(level, toInput(next)));
    }

    const contractOn = !!(inh?.require_contract || own.require_contract);
    const faceOn = !!(inh?.require_face || own.require_face);
    const documentOn = !!(inh?.require_id_document || own.require_id_document);
    const approveOn = !!(inh?.require_first_login_approval || own.require_first_login_approval);
    const linkType: LinkType = own.link_type === 'PERMALINK' || (!own.link_type && inh?.link_type === 'PERMALINK') ? 'PERMALINK' : 'TOKEN';
    // A level above with its own lifetime: this one can only lower it, never drop it.
    const timerLocked = inh?.private_code_minutes != null;
    const timerOn = timerAsked || own.private_code_minutes != null || timerLocked;
    const shownMinutes = own.private_code_minutes ?? policy?.effective.private_code_minutes ?? null;
    const commitMinutes = () => {
        const n = Number(minutes);
        setMinutes(null);
        if (minutes !== null && Number.isInteger(n) && n >= 1 && n !== own.private_code_minutes) save({ private_code_minutes: n });
    };
    // The design's two choices, Contract 1 and Contract 2: the first and second
    // published templates. One that does not exist yet is picked on the screen
    // only (asked of the backend).
    // Contract 1 and 2 are the templates BUSINESS_ADMIN_1 and _2 (contract template
    // answers §2); a project without them falls back to its first two published ones.
    const contractCodes = templates.map((x) => x.code);
    const codeFor = (pick: 'contract1' | 'contract2') => {
        const named = pick === 'contract2' ? 'BUSINESS_ADMIN_2' : 'BUSINESS_ADMIN_1';
        return contractCodes.includes(named) ? named : contractCodes[pick === 'contract2' ? 1 : 0];
    };
    const [contractPick, setContractPick] = useState<'contract1' | 'contract2'>(
        own.contract_types?.[0] && own.contract_types[0] === codeFor('contract2') ? 'contract2' : 'contract1',
    );

    return (
        <div className="flex flex-col gap-6">
            <PanelTitle>{t('title')}</PanelTitle>
            {!policy && <span className="fz-10 text-muted">{t('unavailable')}</span>}

            {/* The design's Permalink / Type 2 / Type 3; the backend has two kinds: PERMALINK and TOKEN. */}
            <ChoiceBox label={t('linkType')}>
                <OneOf
                    options={LINK_TYPES}
                    value={linkType}
                    label={(o) => t(o === 'PERMALINK' ? 'permalink' : 'type2')}
                    disabled={!editable}
                    onChange={(o) => save({ link_type: o })}
                />
            </ChoiceBox>

            <PanelTitle>{t('firstLogin')}</PanelTitle>
            <YesNoBox
                label={t('contract')}
                value={contractOn}
                locked={inh?.require_contract}
                disabled={!editable}
                onChange={(v) => {
                    const code = codeFor(contractPick);
                    save({ require_contract: v ? true : null, contract_types: v && code ? [code] : null });
                }}
                options={['contract1', 'contract2'] as const}
                which={contractPick}
                whichLabel={(o) => t(o)}
                onWhich={(o) => {
                    setContractPick(o);
                    const code = codeFor(o);
                    if (code) save({ require_contract: true, contract_types: [code] });
                }}
            />
            <YesNoBox
                label={t('verification')}
                value={faceOn || documentOn}
                locked={inh?.require_face || inh?.require_id_document}
                disabled={!editable}
                onChange={(v) => save(v ? { require_face: true } : { require_face: null, require_id_document: null })}
                options={['type1', 'type2'] as const}
                which={documentOn ? 'type2' : 'type1'}
                whichLabel={(o) => t(o)}
                onWhich={(o) => save({ require_face: true, require_id_document: o === 'type2' ? true : null })}
            />

            <PanelTitle>{t('beforeLogin')}</PanelTitle>
            <ChoiceBox label={t('loginType')}>
                {/* Fixed (decided 2026-11-21): business levels always sign in to Management. */}
                <OneOf options={['root', 'management'] as const} value="management" label={(o) => t(o)} disabled onChange={() => undefined} />
            </ChoiceBox>
            <YesNoBox
                label={t('approveType')}
                value={approveOn}
                locked={inh?.require_first_login_approval}
                disabled={!editable}
                onChange={(v) => save({ require_first_login_approval: v ? true : null })}
            />

            <PanelTitle>{t('loginInfoSend')}</PanelTitle>
            {/* private_code_minutes: minutes only, never above the deployment's lifetime — so no Hours or Days. */}
            <YesNoBox
                label={t('codeTimer')}
                value={timerOn}
                locked={timerLocked}
                disabled={!editable}
                onChange={(v) => {
                    setTimerAsked(v);
                    if (!v && own.private_code_minutes != null) save({ private_code_minutes: null });
                }}
                options={['minute'] as const}
                which="minute"
                whichLabel={(o) => t(o)}
                onWhich={() => undefined}
            />
            {timerOn && (
                <InfoField
                    label={t('codeMinutes')}
                    editLabel={tw('edit')}
                    onEdit={editable && minutes === null ? () => setMinutes(String(shownMinutes ?? '')) : undefined}
                    value={
                        minutes !== null ? (
                            <input
                                autoFocus
                                inputMode="numeric"
                                value={minutes}
                                onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ''))}
                                onBlur={commitMinutes}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitMinutes();
                                    if (e.key === 'Escape') setMinutes(null);
                                }}
                                className="w-full bg-transparent outline-none"
                            />
                        ) : shownMinutes != null ? (
                            t('codeMinutesValue', { minutes: shownMinutes })
                        ) : (
                            t('codeDefault')
                        )
                    }
                />
            )}
            <ChoiceBox label={t('sendVia')}>
                {/* Fixed (decided 2026-11-21): Get Started sends by WhatsApp; Email and SMS stay greyed out. */}
                <OneOf options={['whatsapp', 'email', 'sms'] as const} value="whatsapp" label={(o) => t(o)} disabled onChange={() => undefined} />
            </ChoiceBox>

            <FormError message={write.result.error} attempt={write.result} />
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
};

/**
 * A pick and, under it, its own picks: turning one off turns its children off;
 * turning a child on turns it on.
 *
 * `folders` (Geographic Regions): a top-level row that saves nothing — a
 * country — only opens and closes. Its mark is green while any level under it
 * is on, and opening it never changes a level.
 */
function OptionTree({
    options,
    onChange,
    folders,
    readOnly,
    after,
}: {
    options: DataOption[];
    onChange: (o: DataOption[]) => void;
    folders?: boolean;
    /** Shown, nothing pickable: this person may not save these settings. */
    readOnly?: boolean;
    /** Something beside a folder row (a country's "Default" mark). */
    after?: (o: DataOption) => ReactNode;
}) {
    const setAll = (o: DataOption, on: boolean): DataOption => ({ ...o, on, children: o.children?.map((c) => setAll(c, on)) });
    const isFolder = (o: DataOption) => !!folders && o.value === undefined && !!o.children;
    const [open, setOpen] = useState(() => new Set(options.filter((o) => isFolder(o) && o.children!.some((c) => c.on)).map((o) => o.id)));
    return (
        <div className="flex flex-col gap-6">
            {options.map((o, i) => {
                const folder = isFolder(o);
                const shown = folder ? open.has(o.id) : o.on;
                return (
                    <div key={o.id} className="flex flex-col gap-6">
                        <div className="flex items-center gap-8">
                            <Choice
                                on={folder ? o.children!.some((c) => c.on) : o.on}
                                label={o.label}
                                tint={folder ? 'green' : undefined}
                                disabled={!folder && (readOnly || o.disabled)}
                                onChange={() =>
                                    folder
                                        ? setOpen((s) => {
                                              const next = new Set(s);
                                              if (next.has(o.id)) next.delete(o.id);
                                              else next.add(o.id);
                                              return next;
                                          })
                                        : onChange(options.map((x, j) => (j === i ? setAll(x, !x.on) : x)))
                                }
                            />
                            {folder && after?.(o)}
                        </div>
                        {o.children && shown && (
                            <div className="ps-12">
                                <OptionTree
                                    options={o.children}
                                    readOnly={readOnly}
                                    onChange={(children) =>
                                        onChange(
                                            options.map((x, j) =>
                                                j === i
                                                    ? { ...x, children, on: folder ? children.some((c) => c.on) : x.on || children.some((c) => c.on) }
                                                    : x,
                                            ),
                                        )
                                    }
                                />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** Every pick of a tree, depth first. */
const flatten = (options: DataOption[]): DataOption[] => options.flatMap((o) => [o, ...flatten(o.children ?? [])]);

/**
 * What Update sends: every list complete. A list on this tab is what is picked
 * on it, plus what RDB holds that the tab does not offer (an item since
 * retired stays, as RDB keeps it); every other list goes back as read.
 */
export function toSettingsInput(tabs: Record<DataTab, DataGroup[]>, settings: RdbSettings): SettingsInput {
    const groups = DATA_TABS.flatMap((id) => tabs[id]);
    const lists = Object.fromEntries(
        SETTINGS_LISTS.map((list) => {
            // A pick saves in its own list, else its group's; the head office's
            // per-country levels go to `levelsByCountry`, not `levels`.
            const picks = groups
                .filter((g) => !g.byCountry)
                .flatMap((g) => flatten(g.options).map((o) => ({ o, in: o.list ?? g.list })))
                .filter((x) => x.in === list && x.o.value !== undefined)
                .map((x) => x.o);
            if (picks.length === 0) return [list, settings[list]];
            const shown = new Set(picks.map((o) => o.value));
            const on = picks.filter((o) => o.on).map((o) => o.value!);
            return [list, [...new Set([...settings[list].filter((v) => !shown.has(v)), ...on])]];
        }),
    ) as Record<SettingsList, SettingsItem[]>;
    return {
        ...lists,
        // The head office's two RDB 1.20 fields: sent exactly when the read had them.
        ...(settings.countries !== undefined ? { countries: settings.countries } : {}),
        ...(settings.workType !== undefined ? { workType: settings.workType } : {}),
        // RDB 1.21: sent exactly when the read had it. A country with its own
        // entry sends its picks; one on the default sends nothing.
        ...(settings.levelsByCountry !== undefined ? { levelsByCountry: levelsByCountryOf(groups, settings.levelsByCountry) } : {}),
        // As read, character for character; LEFT OUT when never saved (null):
        // RDB defines no null here and refused it as STALE_UPDATE.
        ...(settings.updatedAt ? { expectedUpdatedAt: settings.updatedAt } : {}),
    };
}

function levelsByCountryOf(groups: DataGroup[], saved: Record<string, number[]>): Record<string, number[]> {
    const countries = groups.filter((g) => g.byCountry).flatMap((g) => g.options);
    if (countries.length === 0) return saved;
    const shown = new Set(countries.map((c) => c.countryId));
    // Countries the tab does not show (none offered there) keep what RDB holds.
    const kept = Object.fromEntries(Object.entries(saved).filter(([id]) => !shown.has(id)));
    for (const c of countries) {
        if (!c.countryId || !c.custom) continue;
        kept[c.countryId] = (c.children ?? []).filter((l) => l.on && typeof l.value === 'number').map((l) => l.value as number);
    }
    return kept;
}

const sameList = (a: SettingsItem[], b: SettingsItem[]) => a.length === b.length && a.every((v) => b.includes(v));

/**
 * Dashboard Data Setting (XD work structure 21–25): five kinds of project
 * data, each a tree of picks, saved to RDB with Update as the level's complete
 * settings. A group RDB cannot hold yet is shown as designed and not saved.
 */
export function DataSettings({
    level,
    data,
    roleChoices,
    levelRoles,
}: {
    level: Level;
    data: DataSettingsValue;
    /** System RBAC (§5.14a): the roles that could be given here, and this level's limit. */
    roleChoices: GrantRole[];
    levelRoles: LevelRoles | null;
}) {
    const t = useTranslations('work.data');
    const tr = useTranslations('work.data.rbac');
    const locale = useLocale();
    const write = useWorkWrite();
    const rolesWrite = useWorkWrite();
    // A role is on when this level may give it; one a level above leaves out is off and locked.
    const savedRoles = new Set(levelRoles?.effective.map((r) => r.id) ?? []);
    const inherited = levelRoles?.inherited;
    const lockedOut = (id: string) => !!inherited && !inherited.all_roles && !inherited.roles.some((r) => (typeof r === 'string' ? r : r.id) === id);
    const [rolesOn, setRolesOn] = useState(savedRoles);
    const [rolesRead, setRolesRead] = useState(levelRoles);
    if (rolesRead !== levelRoles) {
        setRolesRead(levelRoles);
        setRolesOn(new Set(levelRoles?.effective.map((r) => r.id) ?? []));
    }
    const rolesDirty = !!levelRoles && (rolesOn.size !== savedRoles.size || [...rolesOn].some((id) => !savedRoles.has(id)));
    const [askNoRoles, setAskNoRoles] = useState(false);
    const saveRoles = () => {
        setAskNoRoles(false);
        const usable = roleChoices.filter((r) => !lockedOut(r.id));
        const all = usable.length > 0 && usable.every((r) => rolesOn.has(r.id));
        return rolesWrite.run(() => saveLevelRolesAction(level, all, [...rolesOn]));
    };
    const [tab, setTab] = useState<DataTab>('regions');
    const [draft, setDraft] = useState(data.tabs);
    // Read again (after Update, or someone else's save): start from what is there now.
    const [read, setRead] = useState(data);
    if (read !== data) {
        setRead(data);
        setDraft(data.tabs);
    }
    const { settings } = data;
    const input = settings && toSettingsInput(draft, settings);
    const settingsDirty =
        !!input &&
        (SETTINGS_LISTS.some((list) => !sameList(input[list], settings[list])) ||
            JSON.stringify(input.levelsByCountry ?? null) !== JSON.stringify(settings.levelsByCountry ?? null));
    const dirty = settingsDirty || rolesDirty;
    const setGroup = (gi: number, options: DataOption[]) => {
        write.reset();
        setDraft((d) => ({ ...d, [tab]: d[tab].map((x, j) => (j === gi ? { ...x, options } : x)) }));
    };
    // A country back on the default levels: its picks become `levels` again.
    const toDefault = (c: DataOption): DataOption => ({
        ...c,
        custom: false,
        children: c.children?.map((l) => ({ ...l, on: typeof l.value === 'number' && (settings?.levels ?? []).includes(l.value) })),
    });
    const update = async () => {
        if (rolesDirty && rolesOn.size === 0 && !askNoRoles) return setAskNoRoles(true);
        if (input && (settingsDirty || write.result.commandId)) await write.run(() => saveDataSettingsAction(level, input, write.result.commandId));
        if (rolesDirty) await saveRoles();
    };

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
                                folders={tab === 'regions'}
                                readOnly={!data.mayEdit}
                                after={
                                    g.byCountry
                                        ? (c) =>
                                              c.custom ? (
                                                  // Back to the default: its entry is dropped on Update.
                                                  data.mayEdit && (
                                                      <button
                                                          type="button"
                                                          onClick={() =>
                                                              setGroup(
                                                                  gi,
                                                                  g.options.map((x) => (x.id === c.id ? toDefault(x) : x)),
                                                              )
                                                          }
                                                          className="cursor-pointer fz-10 text-primary"
                                                      >
                                                          {t('useDefault')}
                                                      </button>
                                                  )
                                              ) : (
                                                  <span className="fz-10 text-muted">{t('defaultLevels')}</span>
                                              )
                                        : undefined
                                }
                                onChange={(options) =>
                                    // A country whose levels change gets its own entry.
                                    setGroup(
                                        gi,
                                        g.byCountry
                                            ? options.map((x, k) => (x.children !== g.options[k]?.children ? { ...x, custom: true } : x))
                                            : options,
                                    )
                                }
                            />
                        </ChoiceBox>
                    </div>
                ))}
                {tab === 'rbac' && (
                    <div className="flex flex-col gap-6">
                        <PanelTitle icon="roles/tab-roles">{t('groups.roles')}</PanelTitle>
                        <ChoiceBox>
                            {!levelRoles ? (
                                <span className="fz-10 text-muted">{tr('unavailable')}</span>
                            ) : (
                                roleChoices.map((r) => {
                                    const locked = lockedOut(r.id);
                                    return (
                                        <Choice
                                            key={r.id}
                                            on={!locked && rolesOn.has(r.id)}
                                            label={`${r.short_name} | ${pickName(r.name, locale)}`}
                                            disabled={locked || !levelRoles.may_edit || rolesWrite.busy}
                                            onChange={() => {
                                                rolesWrite.reset();
                                                setAskNoRoles(false);
                                                setRolesOn((s) => {
                                                    const next = new Set(s);
                                                    if (next.has(r.id)) next.delete(r.id);
                                                    else next.add(r.id);
                                                    return next;
                                                });
                                            }}
                                        />
                                    );
                                })
                            )}
                        </ChoiceBox>
                    </div>
                )}
            </div>
            {askNoRoles && (
                // No role here means none beneath either: asked before it is sent.
                <span className="text-center fz-10 text-ink">{tr('noneConfirm')}</span>
            )}
            <FormError message={write.result.error} attempt={write.result} />
            <FormError message={rolesWrite.result.error} attempt={rolesWrite.result} />
            <button
                type="button"
                onClick={() => void update()}
                disabled={!data.mayEdit || (!dirty && !write.result.commandId) || write.busy || rolesWrite.busy}
                // 406 × 50, #3066cc, radius 12 (XD).
                className="mx-auto flex h-50 w-406 max-w-full shrink-0 items-center justify-center gap-6 rad-12 bg-primary fz-12 text-white disabled:opacity-60"
            >
                <Icon name="work/update" size={14} mask />
                {t('update')}
            </button>
        </div>
    );
}

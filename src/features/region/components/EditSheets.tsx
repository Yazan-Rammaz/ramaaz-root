'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
    applyName,
    missingRequired,
    nameChanges,
    nameRows,
    type NameLanguage,
} from '@/features/language/names';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { pickName } from '@/lib/i18n/localized';
import { cn } from '@/lib/utils/cn';
import { updateCountryAction, updateRegionAction } from '../actions';
import { generateCountryDraftAction, translateNameAction } from '../ai';
import type { MapProblem } from '../map-file';
import type { Coded, CountryDraft } from '../mock-ai';
import { countryMap, flagEmoji, resolveFlag, toAlpha2, type GeoImage, type GeoNode } from '../mock-geo';
import { COUNTRY_CODE } from '../schema';
import { useAutoNames } from '../use-auto-names';
import { useWrite } from '../use-write';
import {
    CodedSelect,
    Field,
    InfoBox,
    LevelRow,
    LevelStepper,
    matchOption,
    Section,
    translationOf,
} from './AddCountryDrawer';
import { CloseUnit } from './CloseUnit';
import { MapPicker } from './MapPicker';
import { NameRows } from './NameRows';

/*
 * Editing a saved country or region — the detail sheet with its values as
 * inputs, opened by any of its blue "Edit" titles.
 *
 * What RDB stores is saved there: a country's code, names (en/ar), dial code,
 * level order and default currency (`updateCountryAction`); a region's names,
 * ISO code and type (`updateRegionAction`). Every save sends back the
 * `updatedAt` the record was read with, so a save based on old data is refused
 * (`409 STALE_UPDATE`) instead of overwriting someone else's change
 * (answers 2026-11-05 §2). Both sheets end with Close (`CloseUnit`).
 *
 * Names are kept in every language the project lists (2026-11-08 §2): a save
 * sends only the languages that changed, and an emptied row removes that
 * language (`null`). The rest — main language, post code, GMT, a picked map, a
 * province's plate — has no field in RDB yet
 * (backend docs/project-data/to-backend/2026-11-04-index.md), so it is kept on the
 * screen until a reload, like everything Add fills in.
 */

const NONE: Coded = { code: '', name: '' };

function ReTranslationTitle({ subject }: { subject: string }) {
    return (
        <>
            {subject} Name &quot;System Languages&quot;
        </>
    );
}

function SaveBar({
    write,
    onSave,
    onCancel,
    canSave,
    blocked,
}: {
    write: ReturnType<typeof useWrite>;
    onSave: () => void;
    onCancel: () => void;
    canSave: boolean;
    /** Why Save is off — shown above it, so a greyed button is never a mystery. */
    blocked?: string;
}) {
    return (
        <div className="flex shrink-0 flex-col gap-8 p-24 pt-0">
            {!canSave && blocked && <span className="fz-12 text-center text-red-500">{blocked}</span>}
            <div className="flex gap-8">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={write.busy}
                    className="bg-surface fz-14 rad-12 text-ink h-50 w-110 shrink-0 font-medium disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={onSave}
                    disabled={!canSave || write.busy}
                    aria-busy={write.busy}
                    className="bg-primary fz-14 rad-12 flex h-50 flex-1 items-center justify-center font-medium text-white disabled:opacity-50"
                >
                    ↳ Save Changes
                </button>
            </div>
            <FormError message={write.message} attempt={write.attempt} />
        </div>
    );
}

/* ───────────────────────────── Country ───────────────────────────── */

export function CountryEditSheet({
    country,
    languages,
    languageOptions,
    currencyOptions,
    divisions,
    onSaved,
    onCancel,
    onClosed,
}: {
    country: GeoNode;
    languages: NameLanguage[];
    languageOptions: Coded[];
    currencyOptions: Coded[];
    divisions: Coded[];
    onSaved: (patch: Partial<GeoNode>) => void;
    onCancel: () => void;
    /** RDB closed it — from here, or somebody else did while the sheet was open. */
    onClosed: () => void;
}) {
    const locale = useLocale();
    const details = country.details;
    const write = useWrite();
    const tEdit = useTranslations('region.edit');
    // RDB keeps two-letter codes only (answers 2026-11-05 §2). A country saved
    // with three (JOR) opens with its two-letter one (JO): saving moves it over.
    const savedCode = country.code ?? '';
    const [code, setCode] = useState(() => (savedCode.length === 3 ? toAlpha2(savedCode) || savedCode : savedCode));
    const codeMoved = savedCode.length === 3 && code.trim().toUpperCase() !== savedCode.toUpperCase();
    const [translations, setTranslations] = useState(() => nameRows(languages, country.names));
    const [mainLanguage, setMainLanguage] = useState<Coded>(details?.mainLanguage ?? NONE);
    // The AI's main language when the system doesn't have it (Persian for Iran).
    const [languageNote, setLanguageNote] = useState<string>();
    // Picked by hand, or saved in RDB already: the AI leaves it alone.
    const languageKept = useRef(!!details?.mainLanguage.code);
    const [currency, setCurrency] = useState<Coded>(details?.currency ?? NONE);
    const [phone, setPhone] = useState(details?.phoneCode ?? '');
    const [postCode, setPostCode] = useState(details?.postCode ?? '');
    const [gmt, setGmt] = useState(details?.gmt ?? '');
    const savedLevels = details?.levels ?? [];
    const [levels, setLevels] = useState<(Coded | null)[]>(savedLevels.length ? savedLevels : [null]);
    const [pickedMap, setPickedMap] = useState<GeoImage | null>(null);
    const [mapProblem, setMapProblem] = useState<MapProblem | null>(null);

    const cleanCode = code.trim().toUpperCase();
    const auto = useAutoNames({
        en: translationOf(translations, 'EN'),
        rows: translations,
        setRows: setTranslations,
        // Asked on open for the main language too, even with every name in.
        needsAtOpen: !details?.mainLanguage.code,
        ask: (en) => generateCountryDraftAction(cleanCode, en),
        onAnswer: (d) => {
            if (languageKept.current || !d.mainLanguage.code) return;
            const found = matchOption(languageOptions, d.mainLanguage);
            if (found) setMainLanguage(found);
            setLanguageNote(found ? undefined : `AI suggested ${d.mainLanguage.code} ${d.mainLanguage.name} — not in this system`);
        },
    });
    const namesPhase = auto.phase;
    // Any change makes it a different request — never a retry of the last one.
    const changed = <T,>(set: (v: T) => void) => (v: T) => {
        set(v);
        write.reset();
    };

    const levelsComplete = levels.length > 0 && levels.every((l) => l != null);
    const keysOf = (ls: (Coded | null)[]) => ls.map((l) => l?.key ?? '').join(',');
    const flag = resolveFlag(cleanCode);

    async function save() {
        const chosen = levels.filter((l): l is Coded => l != null);
        // The currency link only when a different one was picked.
        const currencyChanged = !!currency.key && currency.key !== details?.currency.key;
        const name = nameChanges(languages, country.names, translations);
        const result = await write.runResult((resume) =>
            updateCountryAction(
                {
                    id: country.id,
                    code: cleanCode,
                    name,
                    dialCode: phone.trim(),
                    levels: chosen.map((l) => l.key ?? ''),
                    levelsChanged: keysOf(chosen) !== keysOf(savedLevels),
                    currencyId: currencyChanged ? currency.key : undefined,
                    // Only when it changed; RDB takes it in lower case (`ar`).
                    mainLanguage:
                        mainLanguage.key && mainLanguage.key !== details?.mainLanguage.key
                            ? mainLanguage.key
                            : undefined,
                    expectedUpdatedAt: country.updatedAt,
                },
                resume,
            ),
        );
        // Closed by somebody else while the sheet was open: it shows closed, read-only.
        if (result?.closed) return onClosed();
        const ok = result?.ok;
        if (!ok) return;
        const names = applyName(country.names, name);
        const shown = pickName(names, locale);
        const nextDetails: CountryDraft = {
            shortName: cleanCode,
            name: shown,
            translations,
            mainLanguage,
            currency,
            phoneCode: phone.trim(),
            postCode,
            gmt,
            levels: chosen,
        };
        onSaved({
            code: cleanCode,
            name: shown,
            names,
            updatedAt: ok.updatedAt ?? country.updatedAt,
            flag: resolveFlag(cleanCode),
            // A new pick, else an earlier pick, else the generated map for the (maybe new) code.
            map: pickedMap ?? (country.map?.src ? country.map : countryMap(cleanCode)),
            details: nextDetails,
        });
    }

    return (
        <>
            <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                    <Icon name="nav/add" size={18} mask />
                    Edit {country.name}
                    <Icon name="regions/flag" size={18} mask />
                </span>

                <Section title={'Logo & Flag & Map "SVG Format Only"'}>
                    <div className="flex items-center gap-8">
                        {/* The flag follows the code; a new file is uploaded from the sheet itself. */}
                        <span className="bg-surface rad-12 grid h-50 w-64 shrink-0 place-items-center">
                            {flag ? (
                                <Icon name={flag.icon} width={flag.w} height={flag.h} />
                            ) : (
                                <span className="fz-24 leading-none">{flagEmoji(cleanCode)}</span>
                            )}
                        </span>
                        <MapPicker
                            generated={country.map?.src ? country.map : countryMap(cleanCode)}
                            picked={pickedMap}
                            problem={mapProblem}
                            onPick={(r) => {
                                if (typeof r === 'string') return setMapProblem(r);
                                setPickedMap(r);
                                setMapProblem(null);
                            }}
                        />
                    </div>
                </Section>

                <Section title="Country Short Name & Name">
                    {codeMoved && (
                        <span className="fz-12 text-muted">{tEdit('codeMoved', { from: savedCode, to: code.trim().toUpperCase() })}</span>
                    )}
                    <div className="flex gap-4">
                        <Field
                            className="w-128 shrink-0"
                            label="Country Short Name"
                            hint="Max 2/2"
                            value={code}
                            maxLength={2}
                            onChange={changed(setCode)}
                        />
                        <Field
                            className="flex-1"
                            label="Country Name"
                            value={translationOf(translations, 'EN')}
                            onChange={(v) =>
                                changed(setTranslations)(
                                    translations.map((t) => (t.code === 'EN' ? { ...t, name: v } : t)),
                                )
                            }
                        />
                    </div>
                </Section>

                <Section
                    title={
                        <ReTranslationTitle subject="Country" />
                    }
                    phase={namesPhase}
                    ai
                    onAi={auto.retranslate}
                >
                    <NameRows
                        languages={languages}
                        rows={translations}
                        phase={namesPhase}
                        filling={auto.filling}
                        onRetranslate={auto.retranslateOne}
                        errors={write.fields}
                        onChange={(next) => {
                            auto.typed(translations, next);
                            changed(setTranslations)(next);
                        }}
                    />
                </Section>

                <Section title="Country Main Language" phase="ready" ai>
                    <CodedSelect
                        phase="ready"
                        ink
                        value={mainLanguage.code ? mainLanguage : null}
                        options={languageOptions}
                        placeholder="Select Language"
                        note={languageNote}
                        onSelect={(o) => {
                            languageKept.current = true;
                            setLanguageNote(undefined);
                            changed(setMainLanguage)(o);
                        }}
                    />
                </Section>

                <Section title="Country Currency" phase="ready" ai>
                    <CodedSelect
                        phase="ready"
                        ink
                        value={currency.code ? currency : null}
                        options={currencyOptions}
                        placeholder="Select Currency"
                        onSelect={changed(setCurrency)}
                    />
                </Section>

                <Section title="Country General Information" phase="ready" ai>
                    <div className="flex gap-4">
                        <Field
                            className="flex-1"
                            label="Country Phone Code"
                            hint="+963"
                            value={phone}
                            maxLength={5}
                            onChange={changed(setPhone)}
                        />
                        <InfoBox
                            phase="ready"
                            className="flex-1"
                            label="Country Post Code"
                            hint="Yes / No"
                            value={postCode}
                            onChange={changed(setPostCode)}
                        />
                        <InfoBox
                            phase="ready"
                            className="w-94 shrink-0"
                            label="GMT"
                            hint="+3"
                            maxLength={6}
                            value={gmt}
                            onChange={changed(setGmt)}
                        />
                    </div>
                </Section>

                <Section
                    title="The Administrative Divisions In Order"
                    end={
                        <LevelStepper
                            count={levels.length}
                            onRemove={() => changed(setLevels)(levels.length > 1 ? levels.slice(0, -1) : levels)}
                            onAdd={() => changed(setLevels)([...levels, null])}
                        />
                    }
                >
                    {levels.map((lv, i) => (
                        <LevelRow
                            key={i}
                            phase="ready"
                            index={i}
                            value={lv}
                            options={divisions}
                            onSelect={(d) => changed(setLevels)(levels.map((x, j) => (j === i ? d : x)))}
                        />
                    ))}
                </Section>

                <CloseUnit
                    kind="country"
                    id={country.id}
                    name={country.name}
                    hasChildren={country.children.length > 0}
                    childCount={country.children.length}
                    onClosed={onClosed}
                />
            </div>

            <SaveBar
                write={write}
                onSave={save}
                onCancel={onCancel}
                canSave={COUNTRY_CODE.test(cleanCode) && !missingRequired(languages, translations) && levelsComplete}
                blocked={
                    !COUNTRY_CODE.test(cleanCode)
                        ? tEdit('codeInvalid')
                        : missingRequired(languages, translations)
                          ? tEdit('namesMissing')
                          : !levelsComplete
                            ? tEdit('levelsIncomplete')
                            : undefined
                }
            />
        </>
    );
}

/* ───────────────────────────── Region ───────────────────────────── */

export function RegionEditSheet({
    node,
    level,
    countryCode,
    countryName,
    levelName,
    levelType,
    languages,
    divisions,
    onSaved,
    onCancel,
    onClosed,
}: {
    node: GeoNode;
    /** 1 = directly under the country (a province, with an ISO 3166-2 code). */
    level: number;
    countryCode: string;
    countryName: string;
    levelName: string;
    /**
     * Its level's type key in the country's structure — what it is when RDB
     * sent no `regionType` (an old untyped row) or it was added before a reload.
     */
    levelType?: string;
    languages: NameLanguage[];
    /** The region types its type can change to. */
    divisions: Coded[];
    onSaved: (patch: Partial<GeoNode>) => void;
    onCancel: () => void;
    /** RDB closed it — it leaves the tree. */
    onClosed: () => void;
}) {
    const locale = useLocale();
    const write = useWrite();
    const [shortName, setShortName] = useState(node.code ?? '');
    // Its type can change only while nothing is below it (`409 REGION_NOT_EMPTY`).
    const typeLocked = node.children.length > 0;
    // What it is now: RDB's `regionType`, else its level's — the same value
    // `typeChanged` compares with, so an untouched picker never sends a type.
    const startType = node.regionType ?? levelType;
    const [regionType, setRegionType] = useState<Coded | null>(
        divisions.find((d) => d.key === startType) ?? null,
    );
    const [plate, setPlate] = useState(node.plate ?? '');
    const [translations, setTranslations] = useState(() => nameRows(languages, node.names ?? { en: node.name }));
    const [pickedMap, setPickedMap] = useState<GeoImage | null>(null);
    const [mapProblem, setMapProblem] = useState<MapProblem | null>(null);
    const tEdit = useTranslations('region.edit');
    const what = `a ${levelName.toLowerCase() || 'region'} in ${countryName}`;
    const auto = useAutoNames({
        en: translationOf(translations, 'EN'),
        rows: translations,
        setRows: setTranslations,
        ask: async (en) => ({ translations: await translateNameAction(en, what) }),
    });
    const namesPhase = auto.phase;
    const changed = <T,>(set: (v: T) => void) => (v: T) => {
        set(v);
        write.reset();
    };

    const short = shortName.trim().toUpperCase();
    const cc = toAlpha2(countryCode);
    // Only a province has an ISO 3166-2 code (SY-HL); the box is its part
    // after the hyphen. Emptied → cleared in RDB.
    const iso = cc && /^[A-Z0-9]{1,3}$/.test(short) ? `${cc}-${short}` : null;
    const shortValid = level !== 1 || !short || iso != null;

    async function save() {
        const typeChanged = !!regionType?.key && regionType.key !== startType;
        const name = nameChanges(languages, node.names, translations);
        const ok = await write.runOk((resume) =>
            updateRegionAction(
                {
                    id: node.id,
                    name,
                    regionType: typeChanged ? regionType?.key : undefined,
                    expectedUpdatedAt: node.updatedAt,
                    // Deeper levels keep whatever RDB has.
                    isoCode: level === 1 ? iso : node.code && cc ? `${cc}-${node.code}` : null,
                },
                resume,
            ),
        );
        if (!ok) return;
        onSaved({
            updatedAt: ok.updatedAt ?? node.updatedAt,
            regionType: regionType?.key ?? startType,
            code: (level === 1 ? short : node.code) || undefined,
            plate: plate.trim() || undefined,
            name: pickName(applyName(node.names, name), locale),
            names: applyName(node.names, name),
            map: pickedMap ?? node.map,
        });
    }

    return (
        <>
            <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                    <Icon name="nav/add" size={18} mask />
                    Edit {node.name} {levelName}
                </span>

                <Section title={`${levelName} Map & Short Name`}>
                    <div className="flex gap-4">
                        <MapPicker
                            generated={node.map}
                            picked={pickedMap}
                            problem={mapProblem}
                            onPick={(r) => {
                                if (typeof r === 'string') return setMapProblem(r);
                                setPickedMap(r);
                                setMapProblem(null);
                            }}
                        />
                        <Field
                            className={cn('w-120 shrink-0', !shortValid && 'text-red-500')}
                            label={level === 1 ? `${levelName} Short Name (ISO)` : `${levelName} Short Name`}
                            hint="Max 3/3"
                            value={shortName}
                            maxLength={3}
                            onChange={changed(setShortName)}
                        />
                        <Field
                            className="flex-1"
                            label="Code"
                            value={plate}
                            maxLength={4}
                            onChange={changed(setPlate)}
                        />
                    </div>
                </Section>

                <Section title={`${levelName} Type`}>
                    <CodedSelect
                        phase="ready"
                        value={regionType}
                        options={typeLocked ? [] : divisions}
                        placeholder="Select Division"
                        note={typeLocked ? 'The type can change once nothing is below it' : undefined}
                        onSelect={changed(setRegionType)}
                    />
                </Section>

                <Section title={`${levelName} Name`}>
                    <Field
                        label={`${levelName} Name`}
                        value={translationOf(translations, 'EN')}
                        onChange={(v) =>
                            changed(setTranslations)(
                                translations.map((t) => (t.code === 'EN' ? { ...t, name: v } : t)),
                            )
                        }
                    />
                </Section>

                <Section
                    title={
                        <ReTranslationTitle subject={levelName} />
                    }
                    phase={namesPhase}
                    ai
                    onAi={auto.retranslate}
                >
                    <NameRows
                        languages={languages}
                        rows={translations}
                        phase={namesPhase}
                        filling={auto.filling}
                        onRetranslate={auto.retranslateOne}
                        errors={write.fields}
                        onChange={(next) => {
                            auto.typed(translations, next);
                            changed(setTranslations)(next);
                        }}
                    />
                </Section>

                <CloseUnit
                    kind="region"
                    id={node.id}
                    name={node.name}
                    levelName={levelName}
                    hasChildren={node.children.length > 0}
                    childCount={node.children.length}
                    onClosed={onClosed}
                />
            </div>

            <SaveBar
                write={write}
                onSave={save}
                onCancel={onCancel}
                canSave={!missingRequired(languages, translations) && shortValid}
                blocked={
                    missingRequired(languages, translations)
                        ? tEdit('namesMissing')
                        : !shortValid
                          ? tEdit('isoInvalid')
                          : undefined
                }
            />
        </>
    );
}

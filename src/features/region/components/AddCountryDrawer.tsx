'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { iosEase } from '@/components/motion/presets';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { createCountryAction, createRegionAction } from '../actions';
import { generateCountryDraftAction, translateNameAction } from '../ai';
import type { Coded, CountryDraft, Translation } from '../mock-ai';
import { nameForCreate, requiredFilled, rowLanguages, type NameLanguage } from '@/features/language/names';
import type { LocalizedName } from '@/lib/i18n/localized';
import { isIsoCountryCode } from '../flag-codes';
import { readBundledFlag, type FlagProblem, type PickedFlag } from '../flag-file';
import { countryMap, type GeoImage, type GeoNode } from '../mock-geo';
import { titleCase } from '../names';
import type { FlagFile } from '../schema';
import { useWrite } from '../use-write';
import type { MapProblem } from '../map-file';
import { FlagPicker } from './FlagPicker';
import { GeoThumb } from './GeoThumb';
import { MapPicker } from './MapPicker';
import { MissingCurrency } from './MissingCurrency';
import { NameRows } from './NameRows';
import { useAutoNames } from '../use-auto-names';
import type { NameRow } from '@/features/language/names';
import { SubLevelForm, type SubLevelLive, type SubLevelPayload } from './SubLevelForm';

/** A language's name from a draft's (editable) translations; empty when there is none. */
export function translationOf(translations: Translation[] | undefined, code: string) {
    return translations?.find((t) => t.code === code)?.name.trim() ?? '';
}

/**
 * The empty sheet a drawer falls back to when the AI pass could not run at all
 * (the call itself failed): one row per language names can use, English = what
 * was typed, everything else for the person to fill in.
 */
export function emptyTranslations(languages: NameLanguage[], typed: string): Translation[] {
    return rowLanguages(languages).map((l) => ({ code: l.chip, name: l.code === 'en' ? typed : '' }));
}

/**
 * The `name` a new record is created with: every filled row, English falling
 * back to what was typed in the Name field.
 */
export function newName(languages: NameLanguage[], rows: Translation[] | undefined, typedEn: string) {
    const all = rows ?? [];
    const en = translationOf(all, 'EN') || typedEn.trim();
    const withEn = all.some((r) => r.code === 'EN')
        ? all.map((r) => (r.code === 'EN' ? { ...r, name: en } : r))
        : [...all, { code: 'EN', name: en }];
    return nameForCreate(languages, withEn);
}

/**
 * ISO 3166-2 for a level-1 region (`SY` + `DI` → `SY-DI`), when the short name
 * fits one; otherwise nothing is sent. Deeper levels have no ISO code.
 */
export function isoCodeFor(countryCode: string | undefined, shortName: string, depth: number) {
    const cc = countryCode ?? '';
    return depth === 1 && /^[A-Z]{2}$/.test(cc) && /^[A-Z0-9]{1,3}$/.test(shortName)
        ? `${cc}-${shortName}`
        : undefined;
}

export type NewCountry = {
    /** RDB's id for the country just created. */
    id: string;
    code: string;
    name: string;
    levels?: Coded[];
    /** The full generated sheet, kept on the saved node (until refresh). */
    details?: CountryDraft;
    /** A map the person picked over the generated one (until refresh — see map-file.ts). */
    map?: GeoImage;
    /** As saved in RDB — what Edit starts from. */
    names?: LocalizedName;
};
/** A sub-level (province / district / …) being added under a saved node. */
export type NewChild = {
    code?: string;
    plate?: string;
    name: string;
    map?: GeoImage;
    /** As saved in RDB — what Edit starts from. */
    names?: LocalizedName;
};
/** A sub-level RDB has just created — `id` is its id there. */
export type SavedChild = NewChild & {
    id: string;
    /** The region type it was created as (its level's) — what Edit's type picker starts from. */
    regionType?: string;
};
/** Live snapshot of the form, mirrored to the page's left column while typing. */
export type CountryPreview = { code: string; name: string; levels: (Coded | null)[]; map?: GeoImage };
export type Phase = 'idle' | 'gen' | 'ready';

/** Mock level names carry both spellings ("Province / Il") — show the first. */
function levelLabel(l?: Coded) {
    return l?.name.split('/')[0].trim() ?? '';
}

/**
 * Right-side "Add Countries" drawer column (XD add-new-country steps 1–5). All
 * field sections are always visible as empty placeholders; entering the short
 * name + name runs the AI pass (generateCountryDraftAction) — the AI star sparkles (Gemini-style) and
 * the boxes shimmer — then the translations, main language, currency, general
 * info, level rows and the TR logo badges reveal. No inner close control (the
 * navbar "+" becomes an X). "Add & Save" is pinned to the bottom.
 */
type WizardProps = {
    onSaveCountry: (c: NewCountry) => GeoNode;
    onAddChild: (parentId: string, child: SavedChild) => GeoNode;
    onPreview: (p: CountryPreview | null) => void;
    onDraftChild: (parentId: string | null, child: NewChild | null) => void;
    divisions: Coded[];
    /** The project's languages (`language.list`) — the name's translation rows. */
    languages: NameLanguage[];
    /** The system's languages (2-letter codes) and currencies: a country's main language and currency are picked from these. */
    languageOptions: Coded[];
    currencyOptions: Coded[];
    /** RDB takes flag uploads (`media.upload` deployed + `media:write`). */
    flagUploads: boolean;
};

/**
 * The system's language for the one the AI named — by code (`AR`), then by
 * name ("Arabic"). Null when the system has none. (Currencies match by ISO
 * code alone: `currencyByCode`.)
 */
export function matchOption(options: Coded[], suggested: Coded): Coded | null {
    const code = suggested.code.trim().toLowerCase();
    const name = suggested.name.trim().toLowerCase();
    return (
        (code && options.find((o) => o.code.trim().toLowerCase() === code)) ||
        (name && options.find((o) => o.name.trim().toLowerCase() === name)) ||
        null
    );
}

/**
 * The system's currency for the one the AI named — by ISO code only: RDB's
 * `symbol` IS the code (answers 2026-11-05 §1), so a name match would be a
 * guess. Null when the system has none (then it can be added: MissingCurrency).
 */
function currencyByCode(options: Coded[], suggested: Coded): Coded | null {
    const code = suggested.code.trim().toUpperCase();
    return (code && options.find((o) => o.code.trim().toUpperCase() === code)) || null;
}

const NONE: Coded = { code: '', name: '' };

function notInSystem(s: Coded | undefined) {
    return s ? `AI suggested ${s.code} ${s.name} — not in this system` : undefined;
}

export function AddCountryDrawer({
    open,
    ...rest
}: {
    open: boolean;
    onClose: () => void;
} & WizardProps) {
    return <AnimatePresence>{open && <DrawerBody {...rest} />}</AnimatePresence>;
}

/** Wizard stage: adding the country, the "add next level" bridge, a level
 *  sub-form, or done (no levels left). */
type Stage = 'country' | 'await-level' | 'level-form' | 'done';

function DrawerBody({
    onSaveCountry,
    onAddChild,
    onPreview,
    onDraftChild,
    divisions,
    languages,
    languageOptions,
    currencyOptions,
    flagUploads,
}: WizardProps) {
    const [shortName, setShortName] = useState('');
    const [name, setName] = useState('');
    const [generating, setGenerating] = useState(false);
    const [draft, setDraft] = useState<CountryDraft | null>(null);
    // What the AI named when the system has no such language / currency —
    // shown under the picker, so the person knows why it is empty.
    const [unmatched, setUnmatched] = useState<{ language?: Coded; currency?: Coded }>({});
    // Currencies added from here (MissingCurrency) join the picker at once.
    const [addedCurrencies, setAddedCurrencies] = useState<Coded[]>([]);
    const currencyChoices = [...currencyOptions, ...addedCurrencies];
    // The dial code is RDB-required (`+` and 1–4 digits), so it is an input:
    // the AI pass pre-fills it, and the person can type it when it can't.
    const [phone, setPhone] = useState('');
    const [levels, setLevels] = useState<(Coded | null)[]>([null, null, null]);
    const write = useWrite();
    const resetWrite = write.reset;
    const silenceTimer = useRef<number>(0);
    // Each AI request's ticket: an answer that arrives after a newer request
    // (or after the name changed) is dropped.
    const genSeq = useRef(0);
    // The values the last AI answer filled in by itself (not typed) — cleared
    // when the name changes (`schedule`).
    const aiFilled = useRef({ shortName: '', phone: '' });

    // ── Wizard: after the country is saved the drawer stays open and drills
    //    down its levels (Province → District → …), one sub-form at a time.
    const [stage, setStage] = useState<Stage>('country');
    const [chain, setChain] = useState<GeoNode[]>([]);
    const [countryLevels, setCountryLevels] = useState<Coded[]>([]);
    const [levelIndex, setLevelIndex] = useState(0);
    const [subReady, setSubReady] = useState<SubLevelPayload | null>(null);
    // The tree preview — unlike `subReady` (gated on the AI pass, used only
    // to enable Save) this tracks every keystroke from the moment the
    // sub-form opens, so the row shows up immediately (empty label first).
    const [subLive, setSubLive] = useState<SubLevelLive | null>(null);
    const [formKey, setFormKey] = useState(0);
    // An edit to the sub-form makes it a different request: forget any
    // UNKNOWN answer, so the next press is a new action, not a retry.
    const onSubChange = useCallback(
        (p: SubLevelPayload | null) => {
            setSubReady(p);
            resetWrite();
        },
        [resetWrite],
    );

    const parent = chain[chain.length - 1];
    const country = chain[0];
    const nextLevelName = levelLabel(countryLevels[levelIndex]);

    // Debounced off the Name field alone — the short name doesn't gate or
    // restart it, it's just read at fire time (whatever it is by then). The
    // "gen" animation is NOT shown while typing: every keystroke resets a
    // 3s silence timer, and only once that elapses does the animation start
    // (and runs until the AI answers).
    function schedule(sn: string, nm: string) {
        window.clearTimeout(silenceTimer.current);
        genSeq.current++;
        setGenerating(false);
        setDraft(null);
        write.reset();
        // Another name is another country: what the AI filled in for the last
        // one goes (Iraq's IQ / +964 must not ride into the request for Syria),
        // what the person typed stays.
        const fromAi = aiFilled.current;
        if (fromAi.shortName && sn.trim() === fromAi.shortName) {
            sn = '';
            setShortName('');
        }
        if (fromAi.phone && phone === fromAi.phone) setPhone('');
        aiFilled.current = { shortName: '', phone: '' };
        if (!nm.trim()) return;
        silenceTimer.current = window.setTimeout(() => {
            setGenerating(true);
            // Levels are NOT prefilled from the AI draft — the user picks each one.
            const ticket = ++genSeq.current;
            generateCountryDraftAction(sn.trim(), nm.trim())
                .catch(
                    (): CountryDraft => ({
                        shortName: sn.trim(),
                        name: titleCase(nm),
                        translations: emptyTranslations(languages, titleCase(nm)),
                        mainLanguage: { code: '', name: '' },
                        currency: { code: '', name: '' },
                        phoneCode: '',
                        postCode: '',
                        gmt: '',
                        levels: [],
                    }),
                )
                .then((d) => {
                    if (ticket !== genSeq.current) return;
                    // Language and currency are the system's own entries: the AI's
                    // answer picks the matching one, or leaves it to the person.
                    const language = matchOption(languageOptions, d.mainLanguage);
                    const currency = currencyByCode(currencyChoices, d.currency);
                    setDraft({ ...d, mainLanguage: language ?? NONE, currency: currency ?? NONE });
                    setUnmatched({
                        language: !language && d.mainLanguage.code ? d.mainLanguage : undefined,
                        currency: !currency && d.currency.code ? d.currency : undefined,
                    });
                    // The name as it should be written ("syria" → "Syria").
                    // Set directly, not through the field, so it doesn't re-run the AI.
                    setName(d.name);
                    // The AI fills the short name and phone only where nothing was
                    // typed — and remembers that it did, for the next name.
                    setPhone((p) => {
                        if (p.trim()) return p;
                        aiFilled.current.phone = d.phoneCode;
                        return d.phoneCode;
                    });
                    setShortName((s) => {
                        // The code follows the country's NAME: the AI's ISO code
                        // for it replaces whatever was typed (Qatar → QA). Only
                        // when it names no real code does the typed one stay.
                        if (!isIsoCountryCode(d.shortName)) return s.trim() ? s : d.shortName.slice(0, 2);
                        aiFilled.current.shortName = d.shortName.slice(0, 2);
                        return d.shortName.slice(0, 2);
                    });
                    setGenerating(false);
                });
        }, 3000);
    }

    const phase: Phase = generating ? 'gen' : draft ? 'ready' : 'idle';
    // "Re Translation": every row again from the English name. This drawer's
    // own AI pass fills the name as it is typed, so the hook is the button only.
    const setDraftRows: Dispatch<SetStateAction<NameRow[]>> = (u) =>
        setDraft((d) => d && { ...d, translations: typeof u === 'function' ? u(d.translations) : u });
    const auto = useAutoNames({
        en: translationOf(draft?.translations, 'EN') || name.trim(),
        rows: draft?.translations ?? [],
        setRows: setDraftRows,
        ask: async (text) => ({ translations: await translateNameAction(text, 'a country') }),
        auto: false,
    });
    // ISO 3166-1 alpha-2: RDB takes two letters only (answers 2026-11-05 §2).
    const code = shortName.trim().toUpperCase().slice(0, 2);
    // Every generated field is a suggestion the person can correct before saving.
    const editDraft = (patch: (d: CountryDraft) => Partial<CountryDraft>) => {
        setDraft((d) => d && { ...d, ...patch(d) });
        write.reset();
    };
    // A picked file wins over the bundled flag for the code (FlagPicker).
    const [pickedFlag, setPickedFlag] = useState<PickedFlag | null>(null);
    const [flagProblem, setFlagProblem] = useState<FlagProblem | null>(null);
    // Likewise a picked map wins over the generated one (MapPicker).
    const [pickedMap, setPickedMap] = useState<GeoImage | null>(null);
    const [mapProblem, setMapProblem] = useState<MapProblem | null>(null);
    // "Add & Save" only shows once the AI pass is done AND every level row
    // has a division picked — no gaps. The stepper's own minimum is 1.
    const levelsComplete = levels.length >= 1 && levels.every((l) => l != null);

    // Mirror the country draft to the tree — as soon as the drawer opens
    // (empty label), then on every keystroke (country stage only).
    useEffect(() => {
        if (stage !== 'country') {
            onPreview(null);
            return;
        }
        onPreview({ code, name: name.trim(), levels, map: pickedMap ?? undefined });
    }, [stage, code, name, levels, pickedMap, onPreview]);
    useEffect(() => () => onPreview(null), [onPreview]);

    // Mirror the sub-level draft as a live child under its parent in the
    // tree — as soon as the sub-form opens (empty label), then on every
    // keystroke; doesn't wait on the AI pass.
    useEffect(() => {
        if (stage !== 'level-form' || !parent) {
            onDraftChild(null, null);
            return;
        }
        onDraftChild(parent.id, subLive);
    }, [stage, parent, subLive, onDraftChild]);
    useEffect(() => () => onDraftChild(null, null), [onDraftChild]);

    // ── Wizard transitions ────────────────────────────────────────────────
    async function saveCountry() {
        const chosen = levels.filter((l): l is Coded => l != null);
        // With uploads on, the flag goes to RDB: the picked file, else our
        // bundled one for the code. Without them the action falls back to a link.
        let flagFile: FlagFile | null = null;
        if (flagUploads) {
            const f = pickedFlag ?? (await readBundledFlag(code));
            if (!f) {
                setFlagProblem('missing');
                return;
            }
            flagFile = f.file;
        }
        const id = await write.run((resume) =>
            createCountryAction(
                {
                    code,
                    name: newName(languages, draft?.translations, name),
                    dialCode: phone.trim(),
                    levels: chosen.map((l) => l.key ?? ''),
                    // Linked as the country's default after it is created.
                    currencyId: draft?.currency.key || undefined,
                    mainLanguage: draft?.mainLanguage.key || undefined,
                },
                flagFile,
                resume,
            ),
        );
        if (!id) return;
        write.reset(true);
        const node = onSaveCountry({
            id,
            code,
            name: name.trim(),
            levels: chosen,
            map: pickedMap ?? undefined,
            names: newName(languages, draft?.translations, name),
            details: draft
                ? { ...draft, shortName: code, phoneCode: phone.trim(), levels: chosen.length ? chosen : draft.levels }
                : undefined,
        });
        onPreview(null);
        const lv = node.details?.levels ?? [];
        setChain([node]);
        setCountryLevels(lv);
        setLevelIndex(0);
        setStage(lv.length ? 'await-level' : 'done');
    }

    function startLevel() {
        write.reset();
        setSubReady(null);
        setSubLive(null);
        setFormKey((k) => k + 1);
        setStage('level-form');
    }

    async function saveLevel() {
        if (!subReady || !parent) return;
        const id = await write.run((resume) =>
            createRegionAction(
                {
                    parentId: parent.id,
                    name: newName(languages, subReady.draft.translations, subReady.name),
                    regionType: countryLevels[levelIndex]?.key,
                    isoCode: isoCodeFor(country?.code, subReady.code, chain.length),
                },
                resume,
            ),
        );
        if (!id) return;
        write.reset();
        const child = onAddChild(parent.id, {
            id,
            regionType: countryLevels[levelIndex]?.key,
            code: subReady.code || undefined,
            plate: subReady.plate || undefined,
            name: subReady.name,
            map: subReady.map,
            names: newName(languages, subReady.draft.translations, subReady.name),
        });
        onDraftChild(null, null);
        const nextIndex = levelIndex + 1;
        setChain((c) => [...c, child]);
        setLevelIndex(nextIndex);
        setSubReady(null);
        setSubLive(null);
        setStage(nextIndex < countryLevels.length ? 'await-level' : 'done');
    }

    const showCountryForm = stage === 'country' || (stage === 'await-level' && chain.length === 1);
    const showSubForm = stage === 'level-form';
    const showChain = !showCountryForm && !showSubForm; // await-level (deep) / done

    return (
        <motion.aside
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={iosEase}
            className="bg-background relative flex h-full w-430 max-w-full shrink-0 flex-col"
            aria-label="Add country"
        >
            <DashedFrame radius={20} color="#8d8d8d" />

            {/* The level sub-form (Province / District / …) — its own scroller. */}
            {showSubForm && parent && (
                <SubLevelForm
                    key={formKey}
                    parentName={parent.name}
                    levelName={nextLevelName}
                    countryCode={country?.code ?? ''}
                    level={chain.length}
                    parentMap={parent.map}
                    flag={country?.flag}
                    countryDetails={country?.details}
                    languages={languages}
                    onChange={onSubChange}
                    onLiveChange={setSubLive}
                />
            )}

            {/* The drilled chain so far (deep await-level / done). */}
            {showChain && (
                <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                    <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                        <Icon name="nav/add" size={18} mask />
                        {stage === 'done' ? 'All Levels Added' : `Add ${parent?.name} ${nextLevelName}`}
                        {country?.flag && (
                            <Icon
                                name={country.flag.icon}
                                width={country.flag.w}
                                height={country.flag.h}
                            />
                        )}
                    </span>
                    <Section title="Administrative Chain">
                        {chain.map((n, i) => (
                            <div key={n.id} className="flex items-center gap-8" style={{ paddingInlineStart: `${i * 12 * 0.0625}rem` }}>
                                <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                                    {n.map ? (
                                        <GeoThumb image={n.map} scale={Math.min(1, 42 / n.map.w, 42 / n.map.h)} />
                                    ) : (
                                        <span className="fz-12 text-muted">{n.code}</span>
                                    )}
                                </span>
                                <span className="bg-surface rad-12 fz-14 text-ink flex h-50 min-w-0 flex-1 items-center px-12">
                                    {n.name}
                                </span>
                                <span className="bg-surface rad-12 fz-12 text-muted grid h-50 w-80 shrink-0 place-items-center">
                                    {i === 0 ? 'Country' : levelLabel(countryLevels[i - 1])}
                                </span>
                            </div>
                        ))}
                    </Section>
                </div>
            )}

            {/* Scrolling content — reserve the scrollbar gutter so the Save button
          appearing (and the scrollbar with it) never shifts the layout. */}
            {showCountryForm && (
            <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                {/* Header — no close control (the navbar "+" turns into the X). */}
                <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                    <Icon name="nav/add" size={18} mask />
                    Add Countries
                    <Icon name="regions/flag" size={18} mask />
                </span>

                {/* Logo / Flag / Map + TR badges (revealed after generation). */}
                <Section title={'Add Logo & Flag & Map "SVG Format Only"'}>
                    <div className="flex items-center gap-8">
                        {/* Automatic from the code (bundled set); a picked file
                            replaces it once RDB takes uploads. */}
                        <FlagPicker
                            code={code}
                            enabled={flagUploads}
                            picked={pickedFlag}
                            problem={flagProblem}
                            onPick={(r) => {
                                if (typeof r === 'string') {
                                    setFlagProblem(r);
                                    return;
                                }
                                setPickedFlag(r);
                                setFlagProblem(null);
                                // A different flag: an earlier upload must not be reused.
                                write.reset(true);
                            }}
                        />
                        <MapPicker
                            generated={countryMap(code)}
                            picked={pickedMap}
                            problem={mapProblem}
                            onPick={(r) => {
                                if (typeof r === 'string') {
                                    setMapProblem(r);
                                    return;
                                }
                                setPickedMap(r);
                                setMapProblem(null);
                            }}
                        />
                        {BADGE_STYLES.map((cls, i) =>
                            phase === 'ready' ? (
                                <motion.span
                                    key={i}
                                    initial={{ scale: 0, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    transition={{ delay: i * 0.08, ...iosEase }}
                                    style={{ '--hairline-radius': '0.75rem' } as React.CSSProperties}
                                    className={cn(
                                        'fz-12 grid h-50 w-50 shrink-0 place-items-center rad-12 font-semibold',
                                        cls,
                                    )}
                                >
                                    {code}
                                </motion.span>
                            ) : (
                                <span
                                    key={i}
                                    className={cn(
                                        'bg-surface rad-12 h-50 w-50 shrink-0',
                                        shimmer(phase),
                                    )}
                                />
                            ),
                        )}
                    </div>
                </Section>

                {/* Short name + name */}
                <Section title="Add Country Short Name & Name">
                    <div className="flex gap-4">
                        <Field
                            // Generating too, when left empty: the AI fills it with the ISO code.
                            className={cn('w-128 shrink-0', !shortName.trim() && shimmer(phase))}
                            aiPhase={shortName.trim() ? undefined : phase}
                            label="Country Short Name"
                            hint="Max 2/2"
                            value={shortName}
                            maxLength={2}
                            onChange={(v) => {
                                setShortName(v);
                                setFlagProblem(null);
                                // Another code is another country, and another
                                // bundled flag: nothing uploaded before applies.
                                write.reset(true);
                            }}
                        />
                        <Field
                            className="flex-1"
                            label="Country Name"
                            value={name}
                            aiPhase={phase}
                            onChange={(v) => {
                                setName(v);
                                schedule(shortName, v);
                            }}
                        />
                    </div>
                </Section>

                {/* AI-generated sections — always shown; fill on generate. */}
                <Section
                    title={'Country Name Translation "System Languages"'}
                    onAi={draft ? auto.retranslate : undefined}
                    phase={draft ? auto.phase : phase}
                    ai
                >
                    {/* One row per project language; placeholders until the AI pass answers. */}
                    <NameRows
                        languages={languages}
                        rows={draft?.translations ?? null}
                        phase={phase}
                        filling={auto.filling}
                    onRetranslate={auto.retranslateOne}
                        errors={write.fields}
                        onChange={(translations) => {
                            setDraft((d) => d && { ...d, translations });
                            write.reset();
                        }}
                    />
                </Section>

                {/* Picked from the system's own languages and currencies — never typed. */}
                <Section title="Country Main Language" phase={phase} ai>
                    {draft ? (
                        <CodedSelect
                            phase={phase}
                            ink
                            value={draft.mainLanguage.code ? draft.mainLanguage : null}
                            options={languageOptions}
                            placeholder="Select Language"
                            note={notInSystem(unmatched.language)}
                            onSelect={(o) => {
                                editDraft(() => ({ mainLanguage: o }));
                                setUnmatched((u) => ({ ...u, language: undefined }));
                            }}
                        />
                    ) : (
                        <ChipLine phase={phase} />
                    )}
                </Section>

                <Section title="Country Currency" phase={phase} ai>
                    {draft ? (
                        <CodedSelect
                            phase={phase}
                            ink
                            value={draft.currency.code ? draft.currency : null}
                            options={currencyChoices}
                            placeholder="Select Currency"
                            onSelect={(o) => {
                                editDraft(() => ({ currency: o }));
                                setUnmatched((u) => ({ ...u, currency: undefined }));
                            }}
                        />
                    ) : (
                        <ChipLine phase={phase} />
                    )}
                    {draft && unmatched.currency && (
                        <MissingCurrency
                            key={unmatched.currency.code}
                            suggested={unmatched.currency}
                            onAdded={(o) => {
                                setAddedCurrencies((a) => [...a, o]);
                                editDraft(() => ({ currency: o }));
                                setUnmatched((u) => ({ ...u, currency: undefined }));
                            }}
                        />
                    )}
                </Section>

                <Section title="Country General Information" phase={phase} ai>
                    <div className="flex gap-4">
                        <Field
                            className={cn('flex-1', shimmer(phase))}
                            label="Country Phone Code"
                            hint="+963"
                            value={phone}
                            maxLength={5}
                            onChange={(v) => {
                                setPhone(v);
                                write.reset();
                            }}
                        />
                        <InfoBox
                            phase={phase}
                            className="flex-1"
                            label="Country Post Code"
                            hint="Yes / No"
                            value={draft?.postCode}
                            onChange={(v) => editDraft(() => ({ postCode: v }))}
                        />
                        <InfoBox
                            phase={phase}
                            className="w-94 shrink-0"
                            label="GMT"
                            hint="+3"
                            maxLength={6}
                            value={draft?.gmt}
                            onChange={(v) => editDraft(() => ({ gmt: v }))}
                        />
                    </div>
                </Section>

                <Section
                    title="Specify The Administrative Divisions In Order"
                    end={
                        <LevelStepper
                            count={levels.length}
                            onRemove={() =>
                                setLevels((p) => (p.length > 1 ? p.slice(0, -1) : p))
                            }
                            onAdd={() => setLevels((p) => [...p, null])}
                        />
                    }
                >
                    {levels.map((lv, i) => (
                        <LevelRow
                            key={i}
                            phase={phase}
                            index={i}
                            value={lv}
                            options={divisions}
                            onSelect={(d) => {
                                setLevels((p) => p.map((x, j) => (j === i ? d : x)));
                                write.reset();
                            }}
                        />
                    ))}
                </Section>
            </div>
            )}

            {/* Pinned bottom button — Save while editing, "+ Add … Level" between
                levels (the drawer never closes itself). */}
            <WizardButton
                stage={stage}
                countryReady={
                    phase === 'ready' &&
                    levelsComplete &&
                    requiredFilled(languages, newName(languages, draft?.translations, name))
                }
                subReady={subReady != null}
                addLabel={`Add ${parent?.name ?? ''} ${nextLevelName}`}
                busy={write.busy}
                onSaveCountry={saveCountry}
                onStartLevel={startLevel}
                onSaveLevel={saveLevel}
            />
            <FormError message={write.message} attempt={write.attempt} className="px-24 pb-24" />
        </motion.aside>
    );
}

function WizardButton({
    stage,
    countryReady,
    subReady,
    addLabel,
    busy,
    onSaveCountry,
    onStartLevel,
    onSaveLevel,
}: {
    stage: Stage;
    countryReady: boolean;
    subReady: boolean;
    addLabel: string;
    /** A save is on its way to RDB — one press per action. */
    busy: boolean;
    onSaveCountry: () => void;
    onStartLevel: () => void;
    onSaveLevel: () => void;
}) {
    // Resolve the button for the current stage; hidden when the form isn't ready.
    let content: { label: React.ReactNode; onClick: () => void; ink?: boolean } | null = null;
    if (stage === 'country' && countryReady)
        content = { label: <>↳ Add &amp; Save</>, onClick: onSaveCountry };
    else if (stage === 'level-form' && subReady)
        content = { label: <>↳ Add &amp; Save</>, onClick: onSaveLevel };
    else if (stage === 'await-level')
        content = {
            label: (
                <>
                    <Icon name="nav/add" size={14} mask className="text-white" />
                    {addLabel}
                </>
            ),
            onClick: onStartLevel,
            ink: true,
        };

    return (
        <AnimatePresence>
            {content && (
                <motion.div
                    initial={{ y: 24, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 24, opacity: 0 }}
                    className="shrink-0 p-24 pt-0"
                >
                    <button
                        type="button"
                        onClick={content.onClick}
                        disabled={busy}
                        aria-busy={busy}
                        className={cn(
                            'fz-14 rad-12 flex h-50 w-full items-center justify-center gap-8 font-medium text-white disabled:opacity-50',
                            content.ink ? 'bg-ink' : 'bg-primary',
                        )}
                    >
                        {content.label}
                    </button>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export const BADGE_STYLES = [
    'hairline text-ink',
    'bg-surface text-ink',
    'bg-ink text-white',
    'bg-muted text-white',
];

export function shimmer(phase: Phase) {
    return phase === 'gen' ? 'ai-shimmer' : '';
}

/**
 * The AI sparkle marker — gray when idle, brand-blue (and twinkling)
 * otherwise. `size` scales it up for the bigger in-field marker (XD ratio
 * 13:15 preserved).
 */
export function AiMark({ phase, size = 13 }: { phase: Phase; size?: number }) {
    return (
        <motion.span
            aria-hidden
            className={cn('flex shrink-0', phase === 'idle' ? 'text-muted' : 'text-primary')}
            animate={
                phase === 'gen'
                    ? { scale: [1, 1.3, 1], opacity: [0.6, 1, 0.6], rotate: [0, 90, 0] }
                    : { scale: 1, opacity: 1, rotate: 0 }
            }
            transition={phase === 'gen' ? { duration: 1.1, repeat: Infinity } : {}}
        >
            <Icon name="regions/ai" width={size} height={Math.round((size * 15) / 13)} mask />
        </motion.span>
    );
}

/** The AI mark as a button — translates every language again. */
function AiButton({ phase, onClick }: { phase: Phase; onClick: () => void }) {
    const t = useTranslations('region.names');
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={phase === 'gen'}
            aria-label={t('translateAll')}
            title={t('translateAll')}
            className="-m-4 flex p-4 disabled:cursor-default"
        >
            <AiMark phase={phase} />
        </button>
    );
}

export function Section({
    title,
    phase,
    ai,
    onAi,
    end,
    children,
}: {
    title: React.ReactNode;
    phase?: Phase;
    ai?: boolean;
    /** The AI mark becomes a button: every language translated again. */
    onAi?: () => void;
    end?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="flex shrink-0 flex-col gap-8">
            <span className="fz-14 text-ink flex items-center gap-4 font-normal">
                {ai &&
                    (onAi ? (
                        <AiButton phase={phase ?? 'idle'} onClick={onAi} />
                    ) : (
                        <AiMark phase={phase ?? 'idle'} />
                    ))}
                {title}
                {end && <span className="ms-auto">{end}</span>}
            </span>
            {children}
        </div>
    );
}

/** A row's language chip as a button — translates that language again. */
function ChipButton({ code, onClick }: { code: string; onClick: () => void }) {
    const t = useTranslations('region.names');
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={t('translateOne', { code })}
            title={t('translateOne', { code })}
            className="fz-12 bg-ink grid h-50 w-50 shrink-0 place-items-center rad-12 font-semibold text-white"
        >
            {code}
        </button>
    );
}

export function ChipLine({
    phase,
    code,
    value,
    onChange,
    dir,
    onChip,
}: {
    phase: Phase;
    code?: string;
    value?: string;
    /** The chip becomes a button: this language translated again. */
    onChip?: () => void;
    /** Makes the value an input once ready — the AI's answer is a suggestion,
     *  and an empty one (no AI, or it didn't know) is filled in by hand. */
    onChange?: (v: string) => void;
    /** The TEXT's direction, when it is in a language of its own (a name row). */
    dir?: 'ltr' | 'rtl';
}) {
    return (
        <div className="flex items-center gap-8">
            {phase === 'ready' && code && onChip ? (
                <ChipButton code={code} onClick={onChip} />
            ) : phase === 'ready' && code ? (
                <span className="fz-12 bg-ink grid h-50 w-50 shrink-0 place-items-center rad-12 font-semibold text-white">
                    {code}
                </span>
            ) : (
                <span className={cn('bg-surface rad-12 h-50 w-50 shrink-0', shimmer(phase))} />
            )}
            {phase === 'ready' && onChange ? (
                <input
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                    aria-label={code}
                    maxLength={200}
                    dir={dir}
                    className="bg-surface rad-12 fz-14 text-ink h-50 min-w-0 flex-1 px-12 outline-none"
                />
            ) : (
                <span
                    dir={dir}
                    className={cn(
                        'bg-surface rad-12 fz-14 text-ink flex h-50 flex-1 items-center px-12',
                        shimmer(phase),
                    )}
                >
                    {phase === 'ready' ? value : ''}
                </span>
            )}
        </div>
    );
}

/** A draft's translations with row `i` changed. */
export function withTranslation<T extends { translations: Translation[] }>(d: T, i: number, name: string): T {
    return { ...d, translations: d.translations.map((t, j) => (j === i ? { ...t, name } : t)) };
}

export function InfoBox({
    phase,
    label,
    value,
    hint,
    maxLength,
    onChange,
    className,
}: {
    phase: Phase;
    label: string;
    value?: string;
    /** Placeholder once editable — the shape the value takes. */
    hint?: string;
    maxLength?: number;
    /** Makes the value an input once ready, like `ChipLine`. */
    onChange?: (v: string) => void;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'bg-surface rad-12 flex h-54 flex-col justify-center px-12',
                shimmer(phase),
                className,
            )}
        >
            <span className="fz-10 text-muted">{label}</span>
            {phase === 'ready' && onChange ? (
                <input
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={hint}
                    maxLength={maxLength ?? 40}
                    aria-label={label}
                    className="fz-14 text-ink placeholder:fz-8 placeholder:text-muted w-full min-w-0 bg-transparent outline-none"
                />
            ) : (
                <span className="fz-14 text-ink">{phase === 'ready' ? value : ''}</span>
            )}
        </span>
    );
}

/**
 * "- 4 Level +" (XD): the number names the NEXT level — "+" appends it,
 * "−" removes the last row (min 1).
 */
export function LevelStepper({
    count,
    onAdd,
    onRemove,
}: {
    count: number;
    onAdd: () => void;
    onRemove: () => void;
}) {
    return (
        <span className="fz-14 text-primary flex items-center gap-6 font-medium">
            <button
                type="button"
                aria-label="Remove level"
                disabled={count <= 1}
                onClick={onRemove}
                className="disabled:opacity-40"
            >
                −
            </button>
            {count + 1} Level
            <button type="button" aria-label="Add level" onClick={onAdd}>
                +
            </button>
        </span>
    );
}

/**
 * Picking one of the system's own entries (a division, a language, a
 * currency): code chip + the picker + an optional end tag. The picker is not a
 * floating menu — it expands IN FLOW right under the row (pushing the next rows
 * down, so nothing clips inside the scrolling drawer) and lists the options as
 * the same chip+box rows the design uses everywhere; the selected one gets the
 * blue hairline. `note` is a line under the row (e.g. what the AI suggested
 * when the system has no such entry).
 */
export function CodedSelect({
    phase,
    value,
    options,
    placeholder,
    tag,
    ink,
    note,
    onSelect,
}: {
    phase: Phase;
    value: Coded | null;
    options: Coded[];
    placeholder: string;
    /** A box at the end of the row ("Level 1"). */
    tag?: string;
    /** The black code chip of the AI sections, once something is picked. */
    ink?: boolean;
    note?: string;
    onSelect: (d: Coded) => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-8">
                <span
                    className={cn(
                        'rad-12 fz-12 grid h-50 w-50 shrink-0 place-items-center font-medium',
                        ink && value?.code ? 'bg-ink font-semibold text-white' : 'bg-surface text-ink',
                        shimmer(phase),
                    )}
                >
                    {value?.code ?? ''}
                </span>
                <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    onClick={() => setOpen((o) => !o)}
                    className={cn(
                        'bg-surface rad-12 fz-14 flex h-50 min-w-0 flex-1 items-center justify-between px-12 text-start',
                        value ? 'text-ink' : 'text-muted',
                        shimmer(phase),
                    )}
                >
                    {value?.name || placeholder}
                    <Icon
                        name="regions/chevron"
                        size={12}
                        mask
                        className={cn('text-muted shrink-0', open && 'rotate-180')}
                    />
                </button>
                {tag && (
                    <span className="bg-surface rad-12 fz-12 text-muted grid h-50 w-80 shrink-0 place-items-center">
                        {tag}
                    </span>
                )}
            </div>
            {note && <span className="fz-10 text-muted ps-58">{note}</span>}
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={iosEase}
                        className="overflow-hidden"
                    >
                        <ul
                            role="listbox"
                            className="thin-scroll flex max-h-170 flex-col gap-4 overflow-y-auto pb-2"
                        >
                            {options.map((o) => {
                                const selected = value != null && (value.key ?? value.name) === (o.key ?? o.name);
                                return (
                                    <li key={o.key ?? `${o.code}-${o.name}`}>
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={selected}
                                            onClick={() => {
                                                onSelect(o);
                                                setOpen(false);
                                            }}
                                            className="flex w-full items-center gap-8 text-start"
                                        >
                                            <span className="bg-surface rad-12 fz-12 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                                                {o.code}
                                            </span>
                                            <span
                                                className={cn(
                                                    'bg-surface rad-12 fz-14 text-ink flex h-50 min-w-0 flex-1 items-center px-12',
                                                    selected && 'hairline',
                                                )}
                                                style={
                                                    selected
                                                        ? ({
                                                              '--hairline-radius': '0.75rem',
                                                              '--hairline-color': '#388cff',
                                                          } as React.CSSProperties)
                                                        : undefined
                                                }
                                            >
                                                {o.name}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/** One division level: `CodedSelect` over the region types, tagged "Level N". */
export function LevelRow({
    phase,
    index,
    value,
    options,
    onSelect,
}: {
    phase: Phase;
    index: number;
    value: Coded | null;
    options: Coded[];
    onSelect: (d: Coded) => void;
}) {
    return (
        <CodedSelect
            phase={phase}
            value={value}
            options={options}
            placeholder="Select Division"
            tag={`Level ${index + 1}`}
            onSelect={onSelect}
        />
    );
}

export function Field({
    label,
    hint,
    value,
    onChange,
    maxLength,
    className,
    aiPhase,
}: {
    label: string;
    hint?: string;
    value: string;
    onChange: (v: string) => void;
    maxLength?: number;
    className?: string;
    /** Shows a bigger AI sparkle at the end of the field while 'gen' — the cue
     *  that typing this field is what's driving the AI generation. */
    aiPhase?: Phase;
}) {
    return (
        <span
            className={cn(
                'bg-surface rad-12 relative flex h-54 flex-col justify-center px-12',
                aiPhase === 'gen' && 'pe-40',
                className,
            )}
        >
            <span className="fz-10 text-muted">{label}</span>
            <input
                value={value}
                maxLength={maxLength}
                onChange={(e) => onChange(e.target.value)}
                placeholder={hint}
                className="fz-14 text-ink placeholder:fz-8 placeholder:text-muted w-full min-w-0 bg-transparent outline-none"
            />
            {aiPhase === 'gen' && (
                <span className="absolute inset-y-0 end-12 flex items-center">
                    <AiMark phase={aiPhase} size={20} />
                </span>
            )}
        </span>
    );
}

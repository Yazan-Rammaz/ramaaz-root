'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { iosEase } from '@/components/motion/presets';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { generateCountry, SYSTEM_LANGUAGES, type Coded, type CountryDraft } from '../mock-ai';
import type { GeoNode } from '../mock-geo';
import { SubLevelForm, type SubLevelLive, type SubLevelPayload } from './SubLevelForm';

export type NewCountry = {
    code: string;
    name: string;
    levels?: Coded[];
    /** The full generated sheet, kept on the saved node (until refresh). */
    details?: CountryDraft;
};
/** A sub-level (province / district / …) being added under a saved node. */
export type NewChild = { code?: string; plate?: string; name: string };
/** Live snapshot of the form, mirrored to the page's left column while typing. */
export type CountryPreview = { code: string; name: string; levels: (Coded | null)[] };
export type Phase = 'idle' | 'gen' | 'ready';

/** Mock level names carry both spellings ("Province / Il") — show the first. */
function levelLabel(l?: Coded) {
    return l?.name.split('/')[0].trim() ?? '';
}

/**
 * Right-side "Add Countries" drawer column (XD add-new-country steps 1–5). All
 * field sections are always visible as empty placeholders; entering the short
 * name + name runs a 3s mock "AI" pass — the AI star sparkles (Gemini-style) and
 * the boxes shimmer — then the translations, main language, currency, general
 * info, level rows and the TR logo badges reveal. No inner close control (the
 * navbar "+" becomes an X). "Add & Save" is pinned to the bottom.
 */
type WizardProps = {
    onSaveCountry: (c: NewCountry) => GeoNode;
    onAddChild: (parentId: string, child: NewChild) => GeoNode;
    onPreview: (p: CountryPreview | null) => void;
    onDraftChild: (parentId: string | null, child: NewChild | null) => void;
    divisions: Coded[];
};

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
}: WizardProps) {
    const [shortName, setShortName] = useState('');
    const [name, setName] = useState('');
    const [generating, setGenerating] = useState(false);
    const [draft, setDraft] = useState<CountryDraft | null>(null);
    const [levels, setLevels] = useState<(Coded | null)[]>([null, null, null]);
    const silenceTimer = useRef<number>(0);
    const genTimer = useRef<number>(0);

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

    const parent = chain[chain.length - 1];
    const country = chain[0];
    const nextLevelName = levelLabel(countryLevels[levelIndex]);

    // Debounced off the Name field alone — the short name doesn't gate or
    // restart it, it's just read at fire time (whatever it is by then). The
    // "gen" animation is NOT shown while typing: every keystroke resets a
    // 3s silence timer, and only once that elapses does the animation start
    // (then runs its own beat before the draft reveals).
    function schedule(sn: string, nm: string) {
        window.clearTimeout(silenceTimer.current);
        window.clearTimeout(genTimer.current);
        setGenerating(false);
        setDraft(null);
        if (!nm.trim()) return;
        silenceTimer.current = window.setTimeout(() => {
            setGenerating(true);
            // Levels are NOT prefilled from the AI draft — the user picks each one.
            genTimer.current = window.setTimeout(() => {
                setDraft(generateCountry(sn.trim(), nm.trim()));
                setGenerating(false);
            }, 900);
        }, 3000);
    }

    const phase: Phase = generating ? 'gen' : draft ? 'ready' : 'idle';
    const code = shortName.trim().toUpperCase().slice(0, 4);
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
        onPreview({ code, name: name.trim(), levels });
    }, [stage, code, name, levels, onPreview]);
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
    function saveCountry() {
        const chosen = levels.filter((l): l is Coded => l != null);
        const node = onSaveCountry({
            code,
            name: name.trim(),
            levels: chosen,
            details: draft
                ? { ...draft, shortName: code, levels: chosen.length ? chosen : draft.levels }
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
        setSubReady(null);
        setSubLive(null);
        setFormKey((k) => k + 1);
        setStage('level-form');
    }

    function saveLevel() {
        if (!subReady || !parent) return;
        const child = onAddChild(parent.id, {
            code: subReady.code || undefined,
            plate: subReady.plate || undefined,
            name: subReady.name,
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
                    flag={country?.flag}
                    countryDetails={country?.details}
                    onChange={setSubReady}
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
                                        <Icon name={n.map.icon} width={n.map.w} height={n.map.h} />
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
                        <UploadBox label="Flag" />
                        <UploadBox label="SVG Map" />
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
                            className="w-128 shrink-0"
                            label="Country Short Name"
                            hint="Max 4/4"
                            value={shortName}
                            maxLength={4}
                            onChange={setShortName}
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
                <Section title={'Country Name Translation "System Languages"'} phase={phase} ai>
                    {/* Placeholder count while idle/generating comes from the
                        canonical language list, not a hardcoded number — once
                        a draft exists, its own translations drive the rows. */}
                    {Array.from({ length: draft?.translations.length ?? SYSTEM_LANGUAGES.length }, (_, i) => (
                        <ChipLine
                            key={i}
                            phase={phase}
                            code={draft?.translations[i]?.code}
                            value={draft?.translations[i]?.name}
                        />
                    ))}
                </Section>

                <Section title="Country Main Language" phase={phase} ai>
                    <ChipLine
                        phase={phase}
                        code={draft?.mainLanguage.code}
                        value={draft?.mainLanguage.name}
                    />
                </Section>

                <Section title="Country Currency" phase={phase} ai>
                    <ChipLine
                        phase={phase}
                        code={draft?.currency.code}
                        value={draft?.currency.name}
                    />
                </Section>

                <Section title="Country General Information" phase={phase} ai>
                    <div className="flex gap-4">
                        <InfoBox
                            phase={phase}
                            className="flex-1"
                            label="Country Phone Code"
                            value={draft?.phoneCode}
                        />
                        <InfoBox
                            phase={phase}
                            className="flex-1"
                            label="Country Post Code"
                            value={draft?.postCode}
                        />
                        <InfoBox
                            phase={phase}
                            className="w-94 shrink-0"
                            label="GMT"
                            value={draft?.gmt}
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
                            onSelect={(d) =>
                                setLevels((p) => p.map((x, j) => (j === i ? d : x)))
                            }
                        />
                    ))}
                </Section>
            </div>
            )}

            {/* Pinned bottom button — Save while editing, "+ Add … Level" between
                levels (the drawer never closes itself). */}
            <WizardButton
                stage={stage}
                countryReady={phase === 'ready' && levelsComplete}
                subReady={subReady != null}
                addLabel={`Add ${parent?.name ?? ''} ${nextLevelName}`}
                onSaveCountry={saveCountry}
                onStartLevel={startLevel}
                onSaveLevel={saveLevel}
            />
        </motion.aside>
    );
}

function WizardButton({
    stage,
    countryReady,
    subReady,
    addLabel,
    onSaveCountry,
    onStartLevel,
    onSaveLevel,
}: {
    stage: Stage;
    countryReady: boolean;
    subReady: boolean;
    addLabel: string;
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
                        className={cn(
                            'fz-14 rad-12 flex h-50 w-full items-center justify-center gap-8 font-medium text-white',
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

export function Section({
    title,
    phase,
    ai,
    end,
    children,
}: {
    title: React.ReactNode;
    phase?: Phase;
    ai?: boolean;
    end?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="flex shrink-0 flex-col gap-8">
            <span className="fz-14 text-ink flex items-center gap-4 font-normal">
                {ai && <AiMark phase={phase ?? 'idle'} />}
                {title}
                {end && <span className="ms-auto">{end}</span>}
            </span>
            {children}
        </div>
    );
}

export function ChipLine({ phase, code, value }: { phase: Phase; code?: string; value?: string }) {
    return (
        <div className="flex items-center gap-8">
            {phase === 'ready' && code ? (
                <span className="fz-12 bg-ink grid h-50 w-50 shrink-0 place-items-center rad-12 font-semibold text-white">
                    {code}
                </span>
            ) : (
                <span className={cn('bg-surface rad-12 h-50 w-50 shrink-0', shimmer(phase))} />
            )}
            <span
                className={cn(
                    'bg-surface rad-12 fz-14 text-ink flex h-50 flex-1 items-center px-12',
                    shimmer(phase),
                )}
            >
                {phase === 'ready' ? value : ''}
            </span>
        </div>
    );
}

export function InfoBox({
    phase,
    label,
    value,
    className,
}: {
    phase: Phase;
    label: string;
    value?: string;
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
            <span className="fz-14 text-ink">{phase === 'ready' ? value : ''}</span>
        </span>
    );
}

/**
 * "- 4 Level +" (XD): the number names the NEXT level — "+" appends it,
 * "−" removes the last row (min 1).
 */
function LevelStepper({
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
 * One division level: code chip + the division picker + "Level N" tag. The
 * picker is not a floating menu — it expands IN FLOW right under the row
 * (pushing the next rows down, so nothing clips inside the scrolling drawer)
 * and lists the division types as the same chip+box rows the design uses
 * everywhere; the selected one gets the blue hairline.
 */
function LevelRow({
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
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-8">
                <span
                    className={cn(
                        'bg-surface rad-12 fz-12 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium',
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
                    {value?.name ?? 'Select Division'}
                    <Icon
                        name="regions/chevron"
                        size={12}
                        mask
                        className={cn('text-muted shrink-0', open && 'rotate-180')}
                    />
                </button>
                <span className="bg-surface rad-12 fz-12 text-muted grid h-50 w-80 shrink-0 place-items-center">
                    Level {index + 1}
                </span>
            </div>
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
                                const selected = value?.name === o.name;
                                return (
                                    <li key={`${o.code}-${o.name}`}>
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

export function UploadBox({ label }: { label: string }) {
    return (
        <span className="bg-surface rad-12 fz-10 text-muted flex h-50 w-64 shrink-0 flex-col items-center justify-center gap-2">
            <span className="fz-14 leading-none">+</span>
            {label}
        </span>
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

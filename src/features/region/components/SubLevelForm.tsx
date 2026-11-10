'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { motion } from 'motion/react';
import { iosEase } from '@/components/motion/presets';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { generateSubLevelDraftAction, translateNameAction } from '../ai';
import type { MapProblem } from '../map-file';
import { regionMapAction } from '../map-actions';
import type { CountryDraft, SubLevelDraft } from '../mock-ai';
import type { GeoImage } from '../mock-geo';
import { titleCase } from '../names';
import { requiredFilled, type NameLanguage } from '@/features/language/names';
import {
    BADGE_STYLES,
    Field,
    InfoBox,
    Section,
    emptyTranslations,
    translationOf,
    newName,
    shimmer,
    type Phase,
} from './AddCountryDrawer';
import { MapPicker } from './MapPicker';
import { NameRows } from './NameRows';
import { useAutoNames } from '../use-auto-names';
import type { NameRow } from '@/features/language/names';

/** What a completed sub-level form yields (fed to the host's Save button). */
export type SubLevelPayload = {
    code: string;
    plate: string;
    name: string;
    draft: SubLevelDraft;
    /** Its map: the person's pick, else the generated one matched to it. */
    map?: GeoImage;
};

/** The raw fields as typed, unrelated to the AI pass — for the host's live
 *  tree preview, which must track every keystroke, not wait on generation. */
export type SubLevelLive = { code: string; plate: string; name: string; map?: GeoImage };

/**
 * The "Add {Country} {Level}" sub-form (XD "Fixes/ADD_SUB", image 5): the
 * region's map (generated, matched after the AI pass — or the person's own
 * SVG) + AI badges, short-name / code / name, an AI name translation across
 * the system languages, and general info — no currency / language / nested
 * levels. Self-contained: it reports its current savable payload (or null)
 * through `onChange`; the HOST renders the pinned button and the surrounding
 * drawer. Reused by the add-country wizard and the saved-node detail sheet.
 */
export function SubLevelForm({
    parentName,
    levelName,
    countryCode,
    level,
    parentMap,
    flag,
    countryDetails,
    languages,
    onChange,
    onLiveChange,
}: {
    parentName: string;
    levelName: string;
    /** The country it is in (SY, or JOR) — for matching its map. */
    countryCode: string;
    /** 1 = directly under the country (a province), 2 = below that, … */
    level: number;
    /** The parent's map: a district is matched inside its province. */
    parentMap?: GeoImage;
    /** The project's languages — the name's translation rows. */
    languages: NameLanguage[];
    flag?: GeoImage;
    countryDetails?: CountryDraft;
    onChange: (payload: SubLevelPayload | null) => void;
    /** Fires on every keystroke (even empty, from mount) — the tree preview
     *  row so it appears the moment this form opens, not once AI finishes. */
    onLiveChange?: (v: SubLevelLive) => void;
}) {
    const [shortName, setShortName] = useState('');
    const [plate, setPlate] = useState('');
    const [name, setName] = useState('');
    const [generating, setGenerating] = useState(false);
    const [draft, setDraft] = useState<SubLevelDraft | null>(null);
    const silenceTimer = useRef<number>(0);
    // Each AI request's ticket: a late answer for an older name is dropped.
    const genSeq = useRef(0);
    // The codes the last AI answer filled in by itself (not typed) — cleared
    // when the name changes, so one region's codes never stay on the next.
    const aiFilled = useRef({ shortName: '', plate: '' });
    // The map matched to the AI's answer, and one the person picked over it.
    const [matchedMap, setMatchedMap] = useState<GeoImage | null>(null);
    const [pickedMap, setPickedMap] = useState<GeoImage | null>(null);
    const [mapProblem, setMapProblem] = useState<MapProblem | null>(null);
    const map = pickedMap ?? matchedMap ?? undefined;

    // The "gen" animation is NOT shown while typing: every keystroke resets a
    // 3s silence timer, and only once that elapses does the animation start
    // (then runs its own beat before the draft reveals).
    function schedule(nm: string) {
        window.clearTimeout(silenceTimer.current);
        genSeq.current++;
        setGenerating(false);
        setDraft(null);
        setMatchedMap(null);
        const fromAi = aiFilled.current;
        if (fromAi.shortName && shortName.trim() === fromAi.shortName) setShortName('');
        if (fromAi.plate && plate.trim() === fromAi.plate) setPlate('');
        aiFilled.current = { shortName: '', plate: '' };
        if (!nm.trim()) return;
        silenceTimer.current = window.setTimeout(() => {
            setGenerating(true);
            const ticket = ++genSeq.current;
            const what = `a ${levelName.toLowerCase() || 'region'} in ${parentName}${
                countryDetails && countryDetails.name !== parentName ? `, ${countryDetails.name}` : ''
            }`;
            // Where the AI has nothing, a region shares its country's dial code and time zone.
            const inherited = {
                phoneCode: countryDetails?.phoneCode ?? '',
                gmt: countryDetails?.gmt ?? '',
            };
            generateSubLevelDraftAction(nm.trim(), what, inherited)
                .catch(
                    (): SubLevelDraft => ({
                        shortName: '',
                        plate: '',
                        name: titleCase(nm),
                        translations: emptyTranslations(languages, titleCase(nm)),
                        postCode: '',
                        ...inherited,
                    }),
                )
                .then((d) => {
                    if (ticket !== genSeq.current) return;
                    setDraft(d);
                    // The name as it should be written; set directly so it doesn't re-run the AI.
                    setName(d.name);
                    // The AI's codes fill the short name and code only where nothing
                    // was typed — and it remembers that it did, for the next name.
                    setShortName((s) => {
                        if (s.trim()) return s;
                        aiFilled.current.shortName = d.shortName;
                        return d.shortName;
                    });
                    setPlate((p) => {
                        if (p.trim()) return p;
                        aiFilled.current.plate = d.plate;
                        return d.plate;
                    });
                    // Its map, by the ISO code the AI gave (a province) or its
                    // names in every language. No match leaves the box to pick.
                    const short = shortName.trim() || d.shortName;
                    regionMapAction({
                        countryCode,
                        level,
                        parentMap,
                        isoCode: short ? `${countryCode}-${short}` : undefined,
                        names: [d.name, ...d.translations.map((t) => t.name)],
                    })
                        .catch(() => null)
                        .then((m) => {
                            if (ticket === genSeq.current) setMatchedMap(m);
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
        ask: async (text) => ({ translations: await translateNameAction(text, `a ${levelName.toLowerCase() || 'region'} in ${parentName}`) }),
        auto: false,
    });
    const code = shortName.trim().toUpperCase().slice(0, 4);
    // Every generated field is a suggestion the person can correct before saving.
    const editDraft = (patch: Partial<SubLevelDraft>) => setDraft((d) => d && { ...d, ...patch });

    // Report the savable payload live — null until the AI pass actually
    // finishes (not just once a name is typed), so "Add & Save" can't appear
    // mid-generation.
    useEffect(() => {
        // English and Arabic are required: no payload (no Save) until both have text.
        onChange(
            name.trim() && draft && requiredFilled(languages, newName(languages, draft.translations, name))
                ? { code, plate: plate.trim(), name: name.trim(), draft, map }
                : null,
        );
    }, [plate, name, code, draft, map, onChange, languages]);
    useEffect(() => () => onChange(null), [onChange]);

    // Live preview — unconditional, so the tree row exists (empty label)
    // from the moment the form mounts and fills in as the user types.
    useEffect(() => {
        onLiveChange?.({ code, plate: plate.trim(), name: name.trim(), map });
    }, [code, plate, name, map, onLiveChange]);

    return (
        <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
            {/* Header — "+ Add {Country} {Level} {flag}". */}
            <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                <Icon name="nav/add" size={18} mask />
                Add {parentName} {levelName}
                {flag && <Icon name={flag.icon} width={flag.w} height={flag.h} />}
            </span>

            {/* Its map + the AI badges. The map is on the screen only until RDB
                has a field for it (project-data/to-backend/2026-11-02-maps.md). */}
            <Section title={`${levelName} Short Name`}>
                <div className="flex items-center gap-8">
                    <MapPicker
                        generated={matchedMap ?? undefined}
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
                                className={cn('bg-surface rad-12 h-50 w-50 shrink-0', shimmer(phase))}
                            />
                        ),
                    )}
                </div>
            </Section>

            {/* Short name + code + name. */}
            <Section title={`Add ${levelName} Short Name & Name`}>
                <div className="flex gap-4">
                    <Field
                        // Generating too, when left empty: the AI fills these two.
                        className={cn('w-120 shrink-0', !shortName.trim() && shimmer(phase))}
                        aiPhase={shortName.trim() ? undefined : phase}
                        label={`${levelName} Short Name`}
                        hint="Max 4/4"
                        value={shortName}
                        maxLength={4}
                        onChange={setShortName}
                    />
                    <Field
                        className={cn('w-56 shrink-0', !plate.trim() && shimmer(phase))}
                        label="Code"
                        value={plate}
                        maxLength={4}
                        onChange={setPlate}
                    />
                    <Field
                        className="flex-1"
                        label={`${parentName} ${levelName} Name`}
                        value={name}
                        aiPhase={phase}
                        onChange={(v) => {
                            setName(v);
                            schedule(v);
                        }}
                    />
                </div>
            </Section>

            {/* AI name translation across the system languages. */}
            <Section
                title={`${parentName} ${levelName} Translation "System Languages"`}
                onAi={draft ? auto.retranslate : undefined}
                phase={draft ? auto.phase : phase}
                ai
            >
                <NameRows
                    languages={languages}
                    rows={draft?.translations ?? null}
                    phase={phase}
                    filling={auto.filling}
                    onRetranslate={auto.retranslateOne}
                    onChange={(translations) => setDraft((d) => d && { ...d, translations })}
                />
            </Section>

            {/* General info. */}
            <Section title={`${parentName} ${levelName} General Information`} phase={phase} ai>
                <div className="flex gap-4">
                    <InfoBox
                        phase={phase}
                        className="flex-1"
                        label={`${levelName} Phone Code`}
                        hint="+90 212"
                        maxLength={12}
                        value={draft?.phoneCode}
                        onChange={(v) => editDraft({ phoneCode: v })}
                    />
                    <InfoBox
                        phase={phase}
                        className="flex-1"
                        label={`${levelName} Post Code`}
                        hint="34000"
                        maxLength={12}
                        value={draft?.postCode}
                        onChange={(v) => editDraft({ postCode: v })}
                    />
                    <InfoBox
                        phase={phase}
                        className="w-94 shrink-0"
                        label="GMT"
                        hint="+3"
                        maxLength={6}
                        value={draft?.gmt}
                        onChange={(v) => editDraft({ gmt: v })}
                    />
                </div>
            </Section>
        </div>
    );
}

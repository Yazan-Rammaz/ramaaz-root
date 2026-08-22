'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { iosEase } from '@/components/motion/presets';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { generateSubLevel, SYSTEM_LANGUAGES, type CountryDraft, type SubLevelDraft } from '../mock-ai';
import type { GeoImage } from '../mock-geo';
import {
    BADGE_STYLES,
    ChipLine,
    Field,
    InfoBox,
    Section,
    UploadBox,
    shimmer,
    type Phase,
} from './AddCountryDrawer';

/** What a completed sub-level form yields (fed to the host's Save button). */
export type SubLevelPayload = {
    code: string;
    plate: string;
    name: string;
    draft: SubLevelDraft;
};

/** The raw fields as typed, unrelated to the AI pass — for the host's live
 *  tree preview, which must track every keystroke, not wait on generation. */
export type SubLevelLive = { code: string; plate: string; name: string };

/**
 * The "Add {Country} {Level}" sub-form (XD "Fixes/ADD_SUB", image 5): SVG-map
 * upload + AI badges, short-name / code / name, an AI name translation across
 * the system languages, and general info — no currency / language / nested
 * levels. Self-contained: it reports its current savable payload (or null)
 * through `onChange`; the HOST renders the pinned button and the surrounding
 * drawer. Reused by the add-country wizard and the saved-node detail sheet.
 */
export function SubLevelForm({
    parentName,
    levelName,
    flag,
    countryDetails,
    onChange,
    onLiveChange,
}: {
    parentName: string;
    levelName: string;
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
    const genTimer = useRef<number>(0);

    // The "gen" animation is NOT shown while typing: every keystroke resets a
    // 3s silence timer, and only once that elapses does the animation start
    // (then runs its own beat before the draft reveals).
    function schedule(nm: string) {
        window.clearTimeout(silenceTimer.current);
        window.clearTimeout(genTimer.current);
        setGenerating(false);
        setDraft(null);
        if (!nm.trim()) return;
        silenceTimer.current = window.setTimeout(() => {
            setGenerating(true);
            genTimer.current = window.setTimeout(() => {
                setDraft(generateSubLevel(shortName.trim(), nm.trim(), countryDetails));
                setGenerating(false);
            }, 900);
        }, 3000);
    }

    const phase: Phase = generating ? 'gen' : draft ? 'ready' : 'idle';
    const code = shortName.trim().toUpperCase().slice(0, 4);

    // Report the savable payload live — null until the AI pass actually
    // finishes (not just once a name is typed), so "Add & Save" can't appear
    // mid-generation.
    useEffect(() => {
        onChange(
            name.trim() && draft
                ? { code, plate: plate.trim(), name: name.trim(), draft }
                : null,
        );
    }, [plate, name, code, draft, onChange]);
    useEffect(() => () => onChange(null), [onChange]);

    // Live preview — unconditional, so the tree row exists (empty label)
    // from the moment the form mounts and fills in as the user types.
    useEffect(() => {
        onLiveChange?.({ code, plate: plate.trim(), name: name.trim() });
    }, [code, plate, name, onLiveChange]);

    return (
        <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
            {/* Header — "+ Add {Country} {Level} {flag}". */}
            <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                <Icon name="nav/add" size={18} mask />
                Add {parentName} {levelName}
                {flag && <Icon name={flag.icon} width={flag.w} height={flag.h} />}
            </span>

            {/* SVG map upload + AI badges. */}
            <Section title={'Add Map "SVG Format Only"'}>
                <div className="flex items-center gap-8">
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
                        className="w-120 shrink-0"
                        label={`${levelName} Short Name`}
                        hint="Max 4/4"
                        value={shortName}
                        maxLength={4}
                        onChange={setShortName}
                    />
                    <Field
                        className="w-56 shrink-0"
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
                phase={phase}
                ai
            >
                {Array.from({ length: draft?.translations.length ?? SYSTEM_LANGUAGES.length }, (_, i) => (
                    <ChipLine
                        key={i}
                        phase={phase}
                        code={draft?.translations[i]?.code}
                        value={draft?.translations[i]?.name}
                    />
                ))}
            </Section>

            {/* General info. */}
            <Section title={`${parentName} ${levelName} General Information`} phase={phase} ai>
                <div className="flex gap-4">
                    <InfoBox
                        phase={phase}
                        className="flex-1"
                        label={`${levelName} Phone Code`}
                        value={draft?.phoneCode}
                    />
                    <InfoBox
                        phase={phase}
                        className="flex-1"
                        label={`${levelName} Post Code`}
                        value={draft?.postCode}
                    />
                    <InfoBox phase={phase} className="w-94 shrink-0" label="GMT" value={draft?.gmt} />
                </div>
            </Section>
        </div>
    );
}

'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { iosEase } from '@/components/motion/presets';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import type { Coded } from '../mock-ai';
import { flagEmoji, placeholderMap, type GeoNode } from '../mock-geo';
import { BADGE_STYLES, ChipLine, InfoBox, Section, type NewChild } from './AddCountryDrawer';
import { SubLevelForm, type SubLevelLive, type SubLevelPayload } from './SubLevelForm';

const Edit = () => <span className="text-primary">Edit </span>;

/**
 * Right-side sheet for a SAVED geo node (XD add-new-country step 10, "Fixes").
 * Clicking a country in the tree opens its full sheet — flag/map badge row,
 * short name & name, translations, main language, currency, general info and
 * the level order — each block titled with a blue "Edit". Clicking a deeper
 * node opens the same shell reduced to that node. The pinned dark button
 * appends the NEXT level's value under the node ("Add Turkiye Province",
 * "Add Istanbul District", …) through a small inline form. All of it lives in
 * client state only — a refresh resets the mock.
 */
export function CountryDetailDrawer({
    path,
    onAddChild,
    onDraftChild,
}: {
    path: GeoNode[] | null;
    onAddChild: (parentId: string, child: GeoNode) => void;
    /** Live-mirrors the in-progress sub-level to the tree while typing —
     *  same contract as the add-country wizard's draft preview. */
    onDraftChild: (parentId: string | null, child: NewChild | null) => void;
}) {
    // No `key` on Body: drilling into a just-added child swaps its content
    // in place — it must NOT remount the drawer (that replays the slide-in
    // and reads as "closing and reopening a new modal").
    return (
        <AnimatePresence>
            {path && <Body path={path} onAddChild={onAddChild} onDraftChild={onDraftChild} />}
        </AnimatePresence>
    );
}

function Body({
    path,
    onAddChild,
    onDraftChild,
}: {
    path: GeoNode[];
    onAddChild: (parentId: string, child: GeoNode) => void;
    onDraftChild: (parentId: string | null, child: NewChild | null) => void;
}) {
    const node = path[path.length - 1];
    const country = path[0];
    const depth = path.length - 1;
    const details = country.details;
    const isCountry = depth === 0;
    const totalLevels = details?.levels.length ?? 0;
    // The division type this node's children belong to (Province for a
    // country, District for a province, …); null → nothing left to add.
    const nextLevel: Coded | null =
        details?.levels[depth] ?? (isCountry ? { code: '', name: 'Division' } : null);
    // Mock level names carry both spellings ("Province / Il") — label with the first.
    const nextLevelName = nextLevel?.name.split('/')[0].trim() ?? '';

    // The bottom of the level chain (e.g. Street/Neighborhood) has no deeper
    // type to add — instead of hiding the button, offer to add ANOTHER of
    // the SAME type as a sibling under this node's own parent ("Add New
    // Street"), repeatable indefinitely at that last level.
    const isLastLevel = !isCountry && totalLevels > 0 && depth === totalLevels;
    const addParent = isLastLevel ? path[path.length - 2] : node;
    const addLevel: Coded | null = isLastLevel ? (details?.levels[depth - 1] ?? null) : nextLevel;
    const addLevelName = addLevel?.name.split('/')[0].trim() ?? '';

    const [adding, setAdding] = useState(false);
    const [subReady, setSubReady] = useState<SubLevelPayload | null>(null);
    // The tree preview — unlike `subReady` (gated on the AI pass, used only
    // to enable Save) this tracks every keystroke from the moment the form
    // opens, so the row shows up immediately (empty label first).
    const [live, setLive] = useState<SubLevelLive | null>(null);
    // The "already added" list (e.g. "Syria Governorates") starts COLLAPSED —
    // a country with many children was forcing a tall internal scrollbar
    // open by default, which read as broken. Opt-in only.
    const [childrenOpen, setChildrenOpen] = useState(false);
    // Explicit reset counter for the sub-form — same pattern the add-country
    // wizard uses (`formKey`), instead of relying on `node.id` happening to
    // change between adds (true today only because saving re-selects the
    // new node; fragile if that chaining behavior ever changes).
    const [formKey, setFormKey] = useState(0);

    // The drawer stays mounted while drilling from node to node (no remount,
    // no replayed slide-in) — reset the in-progress add form by hand instead,
    // adjusted during render (React's documented pattern for resetting state
    // on a prop change) rather than an effect.
    const [resetFor, setResetFor] = useState(node.id);
    if (resetFor !== node.id) {
        setResetFor(node.id);
        setAdding(false);
        setSubReady(null);
        setLive(null);
        setChildrenOpen(false);
    }

    // Mirror the in-progress sub-level to the tree live, under wherever it
    // will actually land (addParent) — as soon as the form opens (empty
    // label), then updates on every keystroke; doesn't wait on the AI pass.
    useEffect(() => {
        if (!adding) {
            onDraftChild(null, null);
            return;
        }
        onDraftChild(addParent.id, live);
    }, [adding, addParent.id, live, onDraftChild]);
    useEffect(() => () => onDraftChild(null, null), [onDraftChild]);

    const saveChild = () => {
        if (!subReady) return;
        // At the last level this is a SIBLING (same depth as `node`, under
        // `addParent`); otherwise it's `node`'s own next-level child.
        const newDepth = isLastLevel ? depth : depth + 1;
        onAddChild(addParent.id, {
            id: `${addParent.id}-${addParent.children.length}-${subReady.name.toLowerCase()}`,
            code: subReady.code || undefined,
            plate: subReady.plate || undefined,
            name: subReady.name,
            map: placeholderMap(newDepth, addParent.children.length),
            children: [],
        });
        setAdding(false);
        setSubReady(null);
        setLive(null);
    };

    return (
        <motion.aside
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={iosEase}
            className="bg-background relative flex h-full w-430 max-w-full shrink-0 flex-col"
            aria-label={node.name}
        >
            <DashedFrame radius={20} color="#8d8d8d" />

            {/* Adding the next level replaces the whole body with its own
                self-contained form (same shell used by the add-country wizard);
                the drawer itself never closes — only the navbar "X" does. */}
            {adding ? (
                <SubLevelForm
                    key={formKey}
                    parentName={addParent.name}
                    levelName={addLevelName}
                    flag={country.flag}
                    countryDetails={details}
                    onChange={setSubReady}
                    onLiveChange={setLive}
                />
            ) : (
            <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                {/* Header — "{flag} Turkiye Countries {flag glyph}". */}
                <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                    {country.flag ? (
                        <Icon
                            name={country.flag.icon}
                            width={country.flag.w}
                            height={country.flag.h}
                        />
                    ) : (
                        <span className="fz-18 leading-none">
                            {flagEmoji(country.code ?? '')}
                        </span>
                    )}
                    {isCountry
                        ? `${node.name} Countries`
                        : `${node.name} ${details?.levels[depth - 1]?.name.split('/')[0].trim() ?? ''}`}
                    <Icon name="regions/flag" size={18} mask />
                </span>

                {isCountry && (
                    <>
                        {/* Flag / map / code badges. */}
                        <Section title={<><Edit />Logo &amp; Flag &amp; Map &quot;SVG Format Only&quot;</>}>
                            <div className="flex items-center gap-8">
                                <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                                    {country.flag ? (
                                        <Icon
                                            name={country.flag.icon}
                                            width={country.flag.w}
                                            height={country.flag.h}
                                        />
                                    ) : (
                                        <span className="fz-24 leading-none">
                                            {flagEmoji(country.code ?? '')}
                                        </span>
                                    )}
                                </span>
                                <span className="bg-surface rad-12 grid h-50 w-110 shrink-0 place-items-center">
                                    {country.map && (
                                        <Icon
                                            name={country.map.icon}
                                            width={country.map.w}
                                            height={country.map.h}
                                        />
                                    )}
                                </span>
                                {BADGE_STYLES.map((cls, i) => (
                                    <span
                                        key={i}
                                        style={{ '--hairline-radius': '0.75rem' } as React.CSSProperties}
                                        className={cn(
                                            'fz-12 grid h-50 w-50 shrink-0 place-items-center rad-12 font-semibold',
                                            cls,
                                        )}
                                    >
                                        {country.code}
                                    </span>
                                ))}
                            </div>
                        </Section>

                        <Section title={<><Edit />Country Short Name &amp; Name</>}>
                            <div className="flex gap-4">
                                <InfoBox
                                    phase="ready"
                                    className="w-128 shrink-0"
                                    label="Country Short Name"
                                    value={country.code}
                                />
                                <InfoBox
                                    phase="ready"
                                    className="flex-1"
                                    label="Country Name"
                                    value={country.name}
                                />
                            </div>
                        </Section>

                        {details && (
                            <>
                                <Section
                                    title={
                                        <>
                                            Country Name <span className="text-primary">Re Translation</span>{' '}
                                            &quot;System Languages&quot;
                                        </>
                                    }
                                    phase="ready"
                                    ai
                                >
                                    {details.translations.map((tr) => (
                                        <ChipLine
                                            key={tr.code}
                                            phase="ready"
                                            code={tr.code}
                                            value={tr.name}
                                        />
                                    ))}
                                </Section>

                                <Section title="Country Main Language" phase="ready" ai>
                                    <ChipLine
                                        phase="ready"
                                        code={details.mainLanguage.code}
                                        value={details.mainLanguage.name}
                                    />
                                </Section>

                                <Section title="Country Currency" phase="ready" ai>
                                    <ChipLine
                                        phase="ready"
                                        code={details.currency.code}
                                        value={details.currency.name}
                                    />
                                </Section>

                                <Section
                                    title={<><Edit />Country General Information</>}
                                    phase="ready"
                                    ai
                                >
                                    <div className="flex gap-4">
                                        <InfoBox
                                            phase="ready"
                                            className="flex-1"
                                            label="Country Phone Code"
                                            value={details.phoneCode}
                                        />
                                        <InfoBox
                                            phase="ready"
                                            className="flex-1"
                                            label="Country Post Code"
                                            value={details.postCode}
                                        />
                                        <InfoBox
                                            phase="ready"
                                            className="w-94 shrink-0"
                                            label="GMT"
                                            value={details.gmt}
                                        />
                                    </div>
                                </Section>

                                <Section
                                    title={<><Edit />The Administrative Divisions In Order</>}
                                    end={
                                        <span className="fz-14 text-primary font-medium">
                                            − {details.levels.length} Level +
                                        </span>
                                    }
                                >
                                    {details.levels.map((lv, i) => (
                                        <div key={`${lv.code}-${i}`} className="flex items-center gap-8">
                                            <span className="bg-surface rad-12 fz-12 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                                                {lv.code}
                                            </span>
                                            <span className="bg-surface rad-12 fz-14 text-ink flex h-50 min-w-0 flex-1 items-center px-12">
                                                {lv.name}
                                            </span>
                                            <span className="bg-surface rad-12 fz-12 text-muted grid h-50 w-80 shrink-0 place-items-center">
                                                Level {i + 1}
                                            </span>
                                        </div>
                                    ))}
                                </Section>
                            </>
                        )}
                    </>
                )}

                {!isCountry && (
                    /* Deeper node — its own chips row, mirroring its tree row. */
                    <div className="flex items-center gap-4">
                        {node.code && (
                            <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                                {node.code}
                            </span>
                        )}
                        {node.plate && (
                            <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                                {node.plate}
                            </span>
                        )}
                        <span className="bg-surface rad-12 grid h-50 w-110 shrink-0 place-items-center">
                            {node.map && (
                                <Icon name={node.map.icon} width={node.map.w} height={node.map.h} />
                            )}
                        </span>
                        <span className="bg-surface rad-12 fz-14 text-ink flex h-50 min-w-0 flex-1 items-center px-12">
                            {node.name}
                        </span>
                    </div>
                )}

                {/* The values already added under this node — the next one is
                    entered from the pinned form below and appends here live.
                    Collapsed by default (see `childrenOpen` above); expanding
                    scrolls its OWN short, thin-scrollbar region rather than
                    stretching the whole drawer. */}
                {nextLevel && node.children.length > 0 && (
                    <Section
                        title={`${node.name} ${nextLevelName}s`}
                        end={
                            <button
                                type="button"
                                aria-expanded={childrenOpen}
                                aria-label={`${node.name} ${nextLevelName}s`}
                                onClick={() => setChildrenOpen((o) => !o)}
                                className="flex shrink-0 items-center gap-4 p-2"
                            >
                                <span className="fz-12 text-muted">{node.children.length}</span>
                                <Icon
                                    name="regions/chevron"
                                    size={12}
                                    mask
                                    className={cn('text-muted', childrenOpen && 'rotate-180')}
                                />
                            </button>
                        }
                    >
                        {childrenOpen && (
                            <div
                                className="thin-scroll flex max-h-220 flex-col gap-4 overflow-y-auto"
                            >
                                {node.children.map((ch) => (
                                    <div key={ch.id} className="flex items-center gap-4">
                                        {isCountry ? (
                                            <>
                                                <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                                                    {ch.code}
                                                </span>
                                                <span className="bg-surface rad-12 fz-14 text-ink grid h-50 w-50 shrink-0 place-items-center font-medium">
                                                    {ch.plate}
                                                </span>
                                                <span className="bg-surface rad-12 grid h-50 w-110 shrink-0 place-items-center">
                                                    {ch.map && (
                                                        <Icon
                                                            name={ch.map.icon}
                                                            width={ch.map.w}
                                                            height={ch.map.h}
                                                        />
                                                    )}
                                                </span>
                                            </>
                                        ) : (
                                            <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                                                {ch.map && (
                                                    <Icon
                                                        name={ch.map.icon}
                                                        width={ch.map.w}
                                                        height={ch.map.h}
                                                    />
                                                )}
                                            </span>
                                        )}
                                        <span className="bg-surface rad-12 fz-14 text-ink flex h-50 min-w-0 flex-1 items-center px-12">
                                            {ch.name}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>
                )}
            </div>
            )}

            {/* Pinned: opens the sub-form above, then saves it (never closes).
                At the last level this repeats ("Add New Street") instead of
                naming a parent, since it's adding a sibling, not a child. */}
            {addLevel && (
                <div className="flex shrink-0 flex-col gap-8 p-24 pt-0">
                    <button
                        type="button"
                        onClick={
                            adding
                                ? saveChild
                                : () => {
                                      setFormKey((k) => k + 1);
                                      setAdding(true);
                                  }
                        }
                        disabled={adding && !subReady}
                        className="bg-ink fz-14 rad-12 flex h-50 w-full items-center justify-center gap-8 font-medium text-white disabled:opacity-50"
                    >
                        <Icon name="nav/add" size={14} mask className="text-white" />
                        {adding
                            ? `Save ${addLevelName}`
                            : isLastLevel
                              ? `Add New ${addLevelName}`
                              : `Add ${addParent.name} ${addLevelName}`}
                    </button>
                </div>
            )}
        </motion.aside>
    );
}

'use client';

import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { iosEase } from '@/components/motion/presets';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { Field, InfoBox, Section, shimmer, type Phase } from '@/features/region/components/AddCountryDrawer';
import { useWrite } from '@/features/region/use-write';
import { createLanguageAction, setLanguageStatusAction, updateLanguageAction } from '../actions';
import { generateLanguageDraftAction } from '../ai';
import type { LanguageAccess } from '../api';
import {
    LANGUAGE_CODE,
    LANGUAGE_STATUSES,
    type Language,
    type LanguageCoverage,
    type LanguageStatus,
} from '../schema';

/*
 * The Languages screen's sheet (`2026-11-08-languages-screen-and-names.md` §3):
 * add a language, or edit one and change its status. Same shell as the region
 * drawers; the navbar's Close closes it.
 */

type Direction = 'ltr' | 'rtl';
type Fallback = 'en' | 'ar';

/** Scripts written right to left — the direction a new code is prefilled with (the administrator checks it). */
const RTL = new Set(['ar', 'fa', 'ur', 'ckb', 'he', 'ps', 'sd', 'ug', 'yi', 'dv', 'syr']);
const KINDS = ['countries', 'regions', 'branches', 'regionTypes', 'branchTypes', 'currencies'] as const;

/** Direction and fallback suggested for a code: right to left falls back to Arabic, the rest to English. */
function suggest(code: string): { direction: Direction; fallback: Fallback } {
    const base = code.split('-')[0];
    return RTL.has(base) ? { direction: 'rtl', fallback: 'ar' } : { direction: 'ltr', fallback: 'en' };
}

const isRequired = (l: Language) => l.required ?? (l.code === 'en' || l.code === 'ar');

function Choice<T extends string>({
    options,
    value,
    label,
    onChange,
    disabled,
}: {
    options: readonly T[];
    value: T;
    label: (o: T) => string;
    onChange: (o: T) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex gap-8">
            {options.map((o) => (
                <button
                    key={o}
                    type="button"
                    aria-pressed={value === o}
                    disabled={disabled}
                    onClick={() => onChange(o)}
                    className={cn(
                        'fz-14 rad-12 h-50 flex-1 font-medium disabled:opacity-50',
                        value === o ? 'bg-ink text-white' : 'bg-surface text-ink',
                    )}
                >
                    {label(o)}
                </button>
            ))}
        </div>
    );
}

function Shell({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
    return (
        <motion.aside
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={iosEase}
            className="bg-background relative flex h-full w-430 max-w-full shrink-0 flex-col"
            aria-label={title}
        >
            <DashedFrame radius={20} color="#8d8d8d" />
            <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                    <Icon name="nav/translate" size={18} mask />
                    {title}
                </span>
                {children}
            </div>
            <div className="flex shrink-0 flex-col gap-8 p-24 pt-0">{footer}</div>
        </motion.aside>
    );
}

/* ───────────────────────────── Add ───────────────────────────── */

/**
 * `language.create`. The administrator types the language's name in English
 * (or any spelling of it) and, after a pause, the AI pass fills in the rest —
 * code, Arabic name, name in itself, direction, fallback (`generateLanguageDraftAction`).
 * Everything stays editable, and a field typed by hand is never overwritten.
 * The code can never change, so the first press of Add only asks to confirm
 * it. A new language starts as `DRAFT`. Kurdish: the administrators choose
 * which one they mean (`ku` Kurmanji or `ckb` Sorani), explained next to the code.
 */
export function AddLanguageDrawer({ onAdded }: { onAdded: () => void }) {
    const t = useTranslations('language');
    const write = useWrite();
    const [nameEn, setNameEn] = useState('');
    const [code, setCode] = useState('');
    const [nameAr, setNameAr] = useState('');
    const [nativeName, setNativeName] = useState('');
    const [direction, setDirection] = useState<Direction>('ltr');
    const [fallback, setFallback] = useState<Fallback>('en');
    const [sortOrder, setSortOrder] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [phase, setPhase] = useState<Phase>('idle');
    // Fields typed by hand: the AI's answer never replaces them.
    const hand = useRef(new Set<string>());
    const timer = useRef(0);
    // Each AI request's ticket: a late answer for an older name is dropped.
    const ticket = useRef(0);

    const clean = code.trim();
    const codeValid = LANGUAGE_CODE.test(clean);
    const order = sortOrder.trim() === '' ? undefined : Number(sortOrder);
    const orderValid = order === undefined || (Number.isInteger(order) && order >= 0 && order <= 10000);
    const ready = codeValid && !!nameEn.trim() && !!nameAr.trim() && !!nativeName.trim() && orderValid;
    const kurdish = /^(ku|ckb)(-|$)/.test(clean);

    const touched = () => {
        setConfirming(false);
        write.reset();
    };
    /** A field typed by hand: kept from now on. */
    const byHand =
        <T,>(key: string, set: (v: T) => void) =>
        (v: T) => {
            hand.current.add(key);
            set(v);
            touched();
        };

    function typeName(v: string) {
        setNameEn(v);
        touched();
        window.clearTimeout(timer.current);
        const mine = ++ticket.current;
        if (!v.trim()) return setPhase('idle');
        setPhase('idle');
        timer.current = window.setTimeout(() => {
            setPhase('gen');
            generateLanguageDraftAction(v)
                .catch(() => null)
                .then((d) => {
                    if (mine !== ticket.current) return;
                    setPhase('ready');
                    if (!d) return;
                    const fill = <T,>(key: string, set: (v: T) => void, value: T | '') => {
                        if (!hand.current.has(key) && value !== '') set(value as T);
                    };
                    // The name as it should be written ("turkish" → "Turkish"), set
                    // directly so it doesn't run the AI again.
                    fill('nameEn', setNameEn, d.nameEn.trim());
                    fill('code', setCode, d.code.trim());
                    fill('nameAr', setNameAr, d.nameAr.trim());
                    fill('nativeName', setNativeName, d.nativeName.trim());
                    fill('direction', setDirection, d.direction);
                    fill('fallback', setFallback, d.fallback);
                });
        }, 1500);
    }

    async function add() {
        if (!confirming) return setConfirming(true);
        const id = await write.run((resume) =>
            createLanguageAction(
                {
                    code: clean,
                    nameEn: nameEn.trim(),
                    nameAr: nameAr.trim(),
                    nativeName: nativeName.trim(),
                    direction,
                    fallback,
                    sortOrder: order,
                },
                resume,
            ),
        );
        if (id) onAdded();
    }

    const gen = phase === 'gen' ? 'gen' : undefined;

    return (
        <Shell
            title={t('form.addTitle')}
            footer={
                <>
                    {confirming && (
                        <span className="fz-12 text-ink text-center">{t('form.codeConfirm', { code: clean })}</span>
                    )}
                    <button
                        type="button"
                        onClick={add}
                        disabled={!ready || write.busy || phase === 'gen'}
                        aria-busy={write.busy}
                        className="bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center font-medium text-white disabled:opacity-50"
                    >
                        ↳ {confirming ? t('form.confirmAdd', { code: clean }) : t('form.add')}
                    </button>
                    <FormError message={write.message} attempt={write.attempt} />
                </>
            }
        >
            <span className="fz-12 text-muted">{t('form.startsDraft')}</span>

            <Section title={t('form.nameEn')}>
                <Field
                    label={t('form.nameEn')}
                    hint={t('form.nameHint')}
                    value={nameEn}
                    maxLength={200}
                    aiPhase={gen}
                    onChange={typeName}
                />
            </Section>

            <Section title={`${t('form.code')} / ${t('form.nameAr')} / ${t('form.nativeName')}`} phase={phase} ai>
                <div className={cn('flex gap-4', shimmer(gen ?? 'ready'))}>
                    <Field
                        className={cn('w-128 shrink-0', clean && !codeValid && 'text-red-500')}
                        label={t('form.code')}
                        hint={t('form.codeHint')}
                        value={code}
                        maxLength={12}
                        onChange={(v) => {
                            byHand('code', setCode)(v);
                            // Prefilled from the code, unless set by hand; the administrator checks it.
                            const s = suggest(v.trim());
                            if (!hand.current.has('direction')) setDirection(s.direction);
                            if (!hand.current.has('fallback')) setFallback(s.fallback);
                        }}
                    />
                    <Field
                        className="flex-1"
                        label={t('form.nameAr')}
                        value={nameAr}
                        maxLength={200}
                        onChange={byHand('nameAr', setNameAr)}
                    />
                </div>
                {clean && !codeValid && <span className="fz-12 text-red-500">{t('form.codeInvalid')}</span>}
                {kurdish && <span className="fz-12 text-muted">{t('form.kurdish')}</span>}
                <Field
                    className={shimmer(gen ?? 'ready')}
                    label={t('form.nativeName')}
                    value={nativeName}
                    maxLength={100}
                    onChange={byHand('nativeName', setNativeName)}
                />
            </Section>

            <Section title={t('form.direction')} phase={phase} ai>
                <Choice
                    options={['ltr', 'rtl'] as const}
                    value={direction}
                    label={(o) => t(o)}
                    onChange={byHand('direction', setDirection)}
                />
            </Section>

            <Section title={t('form.fallback')} phase={phase} ai>
                <Choice
                    options={['en', 'ar'] as const}
                    value={fallback}
                    label={(o) => o.toUpperCase()}
                    onChange={byHand('fallback', setFallback)}
                />
                <span className="fz-12 text-muted">{t('form.fallbackNote')}</span>
            </Section>

            <Section title={t('form.sortOrder')}>
                <Field
                    className={cn(!orderValid && 'text-red-500')}
                    label={t('form.sortOrder')}
                    hint={t('form.sortHint')}
                    value={sortOrder}
                    maxLength={5}
                    onChange={(v) => {
                        setSortOrder(v);
                        touched();
                    }}
                />
            </Section>
        </Shell>
    );
}

/* ───────────────────────────── Edit ───────────────────────────── */

/**
 * `language.update` (only what changed, with `expectedUpdatedAt`) and
 * `language.status.update` (with a reason). On `en` and `ar` only the names
 * change: direction, fallback and status are locked. Making a language
 * `ACTIVE` is the one change customers see at once, so it is always
 * confirmed, with the coverage behind it.
 */
export function EditLanguageDrawer({
    language,
    languages,
    coverage,
    coverageKnown,
    access,
    onChanged,
}: {
    language: Language;
    /** Every language — the fallback's own name. */
    languages: Language[];
    /** This language's coverage; undefined when it could not be read. */
    coverage: LanguageCoverage | undefined;
    /** Whether coverage was read at all (otherwise the dialog says it couldn't be checked). */
    coverageKnown: boolean;
    access: LanguageAccess;
    /** RDB took a change — the page reads the list again. */
    onChanged: () => void;
}) {
    const t = useTranslations('language');
    const write = useWrite();
    const statusWrite = useWrite();
    const required = isRequired(language);

    // What the form was read from: the diff and `expectedUpdatedAt` are taken against it.
    const [base, setBase] = useState(language);
    const [nameEn, setNameEn] = useState(language.name.en ?? '');
    const [nameAr, setNameAr] = useState(language.name.ar ?? '');
    const [nativeName, setNativeName] = useState(language.nativeName);
    const [direction, setDirection] = useState<Direction>(language.direction);
    const [fallback, setFallback] = useState<Fallback>(language.fallback === 'ar' ? 'ar' : 'en');
    const [sortOrder, setSortOrder] = useState(language.sortOrder?.toString() ?? '');
    const [nextStatus, setNextStatus] = useState<LanguageStatus | null>(null);
    const [reason, setReason] = useState('');

    const changed = <T,>(set: (v: T) => void) => (v: T) => {
        set(v);
        write.reset();
    };

    const order = sortOrder.trim() === '' ? undefined : Number(sortOrder);
    const orderValid = order === undefined || (Number.isInteger(order) && order >= 0 && order <= 10000);
    const diff = {
        nameEn: nameEn.trim() !== (base.name.en ?? '') ? nameEn.trim() : undefined,
        nameAr: nameAr.trim() !== (base.name.ar ?? '') ? nameAr.trim() : undefined,
        nativeName: nativeName.trim() !== base.nativeName ? nativeName.trim() : undefined,
        direction: !required && direction !== base.direction ? direction : undefined,
        fallback: !required && fallback !== (base.fallback ?? 'en') ? fallback : undefined,
        sortOrder: order !== undefined && order !== base.sortOrder ? order : undefined,
    };
    const dirty = Object.values(diff).some((v) => v !== undefined);
    const filled = !!nameEn.trim() && !!nameAr.trim() && !!nativeName.trim();

    function startFrom(next: Language) {
        setBase(next);
        setNameEn(next.name.en ?? '');
        setNameAr(next.name.ar ?? '');
        setNativeName(next.nativeName);
        setDirection(next.direction);
        setFallback(next.fallback === 'ar' ? 'ar' : 'en');
        setSortOrder(next.sortOrder?.toString() ?? '');
    }

    async function save() {
        const result = await write.runResult((resume) =>
            updateLanguageAction({ code: base.code, ...diff, expectedUpdatedAt: base.updatedAt }, resume),
        );
        // Somebody saved first: their values, and the next press is a new request.
        if (result?.fresh) return startFrom(result.fresh as Language);
        if (result?.ok) onChanged();
    }

    async function changeStatus() {
        if (!nextStatus) return;
        const ok = await statusWrite.runOk((resume) =>
            setLanguageStatusAction({ code: base.code, status: nextStatus, reason: reason.trim() }, resume),
        );
        if (ok) onChanged();
    }

    const fallbackName =
        languages.find((l) => l.code === (base.fallback ?? 'en'))?.nativeName ?? (base.fallback ?? 'en');
    const missingKinds = KINDS.flatMap((k) => {
        const n = coverage?.kinds?.[k]?.missing ?? 0;
        return n > 0 ? [t(`kinds.${k}`, { count: n })] : [];
    }).join(', ');

    /** What changing to `next` means for customers — said before the reason is asked. */
    function consequences(next: LanguageStatus): string[] {
        if (next === 'ACTIVE') {
            const lines = [t('change.activeLead', { name: base.nativeName })];
            if (!coverageKnown || !coverage) lines.push(t('change.unchecked'));
            else if (coverage.percent < 100)
                lines.push(t('change.missing', { kinds: missingKinds || coverage.missing, fallback: fallbackName }));
            else lines.push(t('change.complete'));
            lines.push(t('change.messages', { fallback: fallbackName }));
            return lines;
        }
        if (next === 'INACTIVE') return [t('change.inactive')];
        return [base.status === 'ACTIVE' ? t('change.draftFromActive') : t('change.draftFromInactive')];
    }

    return (
        <Shell
            title={t('form.editTitle', { name: base.nativeName })}
            footer={
                access.update && (
                    <>
                        <button
                            type="button"
                            onClick={save}
                            disabled={!dirty || !filled || !orderValid || write.busy}
                            aria-busy={write.busy}
                            className="bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center font-medium text-white disabled:opacity-50"
                        >
                            ↳ {t('form.save')}
                        </button>
                        <FormError message={write.message} attempt={write.attempt} />
                    </>
                )
            }
        >
            <Section title={t('form.code')}>
                <div className="flex gap-4">
                    <InfoBox phase="ready" className="w-128 shrink-0" label={t('form.code')} value={base.code} />
                    {access.update ? (
                        <Field
                            className="flex-1"
                            label={t('form.nativeName')}
                            value={nativeName}
                            maxLength={100}
                            onChange={changed(setNativeName)}
                        />
                    ) : (
                        <InfoBox phase="ready" className="flex-1" label={t('form.nativeName')} value={nativeName} />
                    )}
                </div>
            </Section>

            {access.update && (
                <>
                    <Section title={`${t('form.nameEn')} / ${t('form.nameAr')}`}>
                        <Field label={t('form.nameEn')} value={nameEn} maxLength={200} onChange={changed(setNameEn)} />
                        <Field label={t('form.nameAr')} value={nameAr} maxLength={200} onChange={changed(setNameAr)} />
                    </Section>

                    <Section title={t('form.direction')}>
                        <Choice
                            options={['ltr', 'rtl'] as const}
                            value={direction}
                            label={(o) => t(o)}
                            onChange={changed(setDirection)}
                            disabled={required}
                        />
                    </Section>

                    <Section title={t('form.fallback')}>
                        <Choice
                            options={['en', 'ar'] as const}
                            value={fallback}
                            label={(o) => o.toUpperCase()}
                            onChange={changed(setFallback)}
                            disabled={required}
                        />
                        <span className="fz-12 text-muted">
                            {required ? t('form.requiredLocked') : t('form.fallbackNote')}
                        </span>
                    </Section>

                    <Section title={t('form.sortOrder')}>
                        <Field
                            className={cn(!orderValid && 'text-red-500')}
                            label={t('form.sortOrder')}
                            hint={t('form.sortHint')}
                            value={sortOrder}
                            maxLength={5}
                            onChange={changed(setSortOrder)}
                        />
                    </Section>
                </>
            )}

            {coverage && (
                <Section title={t('coverage.title')}>
                    <span className="fz-14 text-ink">
                        {t('coverage.line', { percent: coverage.percent, missing: coverage.missing, total: coverage.total })}
                    </span>
                    {missingKinds && <span className="fz-12 text-muted">{missingKinds}</span>}
                </Section>
            )}

            {access.status && (
                <Section title={t('change.title')}>
                    {required ? (
                        <span className="fz-12 text-muted">{t('change.locked')}</span>
                    ) : (
                        <>
                            <Choice
                                options={LANGUAGE_STATUSES}
                                value={nextStatus ?? base.status}
                                label={(o) => t(`status.${o}`)}
                                onChange={(o) => {
                                    setNextStatus(o === base.status ? null : o);
                                    statusWrite.reset(true);
                                }}
                                disabled={statusWrite.busy}
                            />
                            {nextStatus && (
                                <div className="flex flex-col gap-8">
                                    {consequences(nextStatus).map((line) => (
                                        <span key={line} className="fz-12 text-ink">
                                            {line}
                                        </span>
                                    ))}
                                    <Field
                                        label={t('change.reason')}
                                        value={reason}
                                        maxLength={500}
                                        onChange={(v) => {
                                            setReason(v);
                                            statusWrite.reset();
                                        }}
                                    />
                                    <div className="flex gap-8">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setNextStatus(null);
                                                statusWrite.reset(true);
                                            }}
                                            disabled={statusWrite.busy}
                                            className="bg-surface fz-14 rad-12 text-ink h-50 w-110 shrink-0 font-medium disabled:opacity-50"
                                        >
                                            {t('change.cancel')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={changeStatus}
                                            disabled={!reason.trim() || statusWrite.busy}
                                            aria-busy={statusWrite.busy}
                                            className="bg-ink fz-14 rad-12 h-50 flex-1 font-medium text-white disabled:opacity-50"
                                        >
                                            {t('change.confirm', { status: t(`status.${nextStatus}`) })}
                                        </button>
                                    </div>
                                    <FormError message={statusWrite.message} attempt={statusWrite.attempt} />
                                </div>
                            )}
                        </>
                    )}
                </Section>
            )}
        </Shell>
    );
}

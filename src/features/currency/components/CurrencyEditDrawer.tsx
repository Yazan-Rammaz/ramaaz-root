'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { iosEase } from '@/components/motion/presets';
import { DashedFrame } from '@/components/ui/DashedFrame';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { pickName } from '@/lib/i18n/localized';
import { cn } from '@/lib/utils/cn';
import {
    applyName,
    missingRequired,
    nameChanges,
    nameRows,
    type NameLanguage,
} from '@/features/language/names';
import { Field, Section, translationOf } from '@/features/region/components/AddCountryDrawer';
import { NameRows } from '@/features/region/components/NameRows';
import { translateNameAction } from '@/features/region/ai';
import { useAutoNames } from '@/features/region/use-auto-names';
import { CURRENCY_CODE } from '@/features/region/schema';
import { useWrite } from '@/features/region/use-write';
import { updateCurrencyAction } from '../actions';
import type { Currency } from '../schema';

/**
 * Editing a currency — the right-side sheet the list opens on a row, in the
 * same shell as the region drawers: its ISO code, its name in every language
 * the project lists, and whether it is active (`currency.update`).
 *
 * Every save sends back the `updatedAt` the currency was read with. When
 * somebody else saved first (`409 STALE_UPDATE`) nothing was saved: the sheet
 * takes their values (the action reads the currency again) and says so, and
 * the next press is a new request. A few old currencies hold a symbol that is
 * not an ISO code; they show as they are, but the code must be corrected to
 * save (answers 2026-11-05 §1).
 */
export function CurrencyEditDrawer({
    currency,
    languages,
    onSaved,
}: {
    currency: Currency;
    languages: NameLanguage[];
    /** RDB took the change, or answered with newer values — the list shows them. */
    onSaved: (next: Currency) => void;
}) {
    const t = useTranslations('currency.edit');
    const locale = useLocale();
    const write = useWrite();
    // What the form was read from: the diff and `expectedUpdatedAt` are taken against it.
    const [base, setBase] = useState(currency);
    const [code, setCode] = useState(currency.code ?? '');
    const [rows, setRows] = useState(() => nameRows(languages, currency.names));
    const [active, setActive] = useState(currency.isActive ?? true);
    // The AI fills the empty languages after the English name changes; its
    // mark redoes them all, a language's chip just that one.
    const auto = useAutoNames({
        en: translationOf(rows, 'EN'),
        rows,
        setRows,
        ask: async (text) => ({ translations: await translateNameAction(text, 'a currency') }),
    });

    const changed = <T,>(set: (v: T) => void) => (v: T) => {
        set(v);
        write.reset();
    };

    const symbol = code.trim().toUpperCase();
    const codeValid = CURRENCY_CODE.test(symbol);
    const name = nameChanges(languages, base.names, rows);
    const symbolChanged = symbol !== (base.code ?? '');
    const activeChanged = active !== (base.isActive ?? true);
    const dirty = !!name || symbolChanged || activeChanged;

    /** Show `next` as the form's starting point (after a save, or someone else's). */
    function startFrom(next: Currency) {
        setBase(next);
        setCode(next.code ?? '');
        setRows(nameRows(languages, next.names));
        setActive(next.isActive ?? true);
        onSaved(next);
    }

    async function save() {
        const result = await write.runResult((resume) =>
            updateCurrencyAction(
                {
                    id: base.id,
                    ...(symbolChanged ? { symbol } : {}),
                    ...(name ? { name } : {}),
                    ...(activeChanged ? { isActive: active } : {}),
                    expectedUpdatedAt: base.updatedAt,
                },
                resume,
            ),
        );
        if (result?.fresh) return startFrom(result.fresh as Currency);
        if (!result?.ok) return;
        const names = applyName(base.names, name);
        startFrom({
            ...base,
            code: symbol,
            names,
            name: pickName(names, locale),
            isActive: active,
            updatedAt: result.ok.updatedAt ?? base.updatedAt,
        });
    }

    return (
        <motion.aside
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={iosEase}
            className="bg-background relative flex h-full w-430 max-w-full shrink-0 flex-col"
            aria-label={t('title', { name: base.name })}
        >
            <DashedFrame radius={20} color="#8d8d8d" />

            <div className="thin-scroll flex flex-1 flex-col gap-24 overflow-y-auto px-12 py-24">
                <span className="fz-16 text-ink flex items-center gap-8 font-medium">
                    <Icon name="nav/currencies" size={18} mask />
                    {t('title', { name: base.name })}
                </span>

                <Section title={t('name')}>
                    <div className="flex gap-4">
                        <Field
                            className={cn('w-110 shrink-0', !codeValid && 'text-red-500')}
                            label={t('code')}
                            hint={t('codeHint')}
                            value={code}
                            maxLength={3}
                            onChange={changed(setCode)}
                        />
                        <Field
                            className="flex-1"
                            label={t('name')}
                            value={translationOf(rows, 'EN')}
                            onChange={(v) => changed(setRows)(rows.map((r) => (r.code === 'EN' ? { ...r, name: v } : r)))}
                        />
                    </div>
                    {!codeValid && <span className="fz-12 text-red-500">{t('codeInvalid')}</span>}
                </Section>

                <Section title={t('translations')} phase={auto.phase} ai onAi={auto.retranslate}>
                    <NameRows
                        languages={languages}
                        rows={rows}
                        phase="ready"
                        filling={auto.filling}
                        onRetranslate={auto.retranslateOne}
                        skip={['EN']}
                        errors={write.fields}
                        onChange={(next) => {
                            auto.typed(rows, next);
                            changed(setRows)(next);
                        }}
                    />
                </Section>

                <Section title={`${t('active')} / ${t('inactive')}`}>
                    <div className="flex gap-8">
                        {[true, false].map((on) => (
                            <button
                                key={String(on)}
                                type="button"
                                aria-pressed={active === on}
                                onClick={() => changed(setActive)(on)}
                                className={cn(
                                    'fz-14 rad-12 h-50 flex-1 font-medium',
                                    active === on ? 'bg-ink text-white' : 'bg-surface text-ink',
                                )}
                            >
                                {on ? t('active') : t('inactive')}
                            </button>
                        ))}
                    </div>
                </Section>
            </div>

            <div className="flex shrink-0 flex-col gap-8 p-24 pt-0">
                <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || !codeValid || missingRequired(languages, rows) || write.busy}
                    aria-busy={write.busy}
                    className="bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center font-medium text-white disabled:opacity-50"
                >
                    ↳ {t('save')}
                </button>
                <FormError message={write.message} attempt={write.attempt} />
            </div>
        </motion.aside>
    );
}

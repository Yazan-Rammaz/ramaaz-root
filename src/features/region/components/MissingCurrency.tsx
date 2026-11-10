'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FormError } from '@/components/ui/FormError';
import { createCurrencyAction } from '../actions';
import { translateNameAction } from '../ai';
import type { Coded } from '../mock-ai';
import { CURRENCY_CODE } from '../schema';
import { useWrite } from '../use-write';
import { Field } from './AddCountryDrawer';

/**
 * The currency the AI named is not in the system (answers 2026-11-05 §1):
 * offer to add it — `currency.create` with its ISO code and names — and hand
 * the new entry back to be picked. Nothing is created without the click.
 *
 * RDB needs the Arabic name too; the AI fills it in and it stays editable.
 * Only a three-letter ISO code can be added (RDB refuses anything else).
 */
export function MissingCurrency({
    suggested,
    onAdded,
}: {
    suggested: Coded;
    onAdded: (option: Coded) => void;
}) {
    const t = useTranslations('region.currency');
    const write = useWrite();
    const code = suggested.code.trim().toUpperCase();
    const [nameAr, setNameAr] = useState('');

    useEffect(() => {
        let live = true;
        translateNameAction(suggested.name, 'a currency')
            .then((all) => {
                const ar = all.find((x) => x.code === 'AR')?.name.trim();
                if (live && ar) setNameAr((v) => v || ar);
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [suggested.name]);

    async function add() {
        const id = await write.run((resume) =>
            createCurrencyAction({ symbol: code, name: { en: suggested.name.trim(), ar: nameAr.trim() } }, resume),
        );
        if (id) onAdded({ key: id, code, name: suggested.name.trim() });
    }

    if (!CURRENCY_CODE.test(code)) return null;

    return (
        <div className="flex flex-col gap-8">
            <span className="fz-12 text-muted">{t('missing', { code, name: suggested.name })}</span>
            <div className="flex gap-4">
                <Field
                    className="flex-1"
                    label={t('arName')}
                    value={nameAr}
                    maxLength={200}
                    onChange={(v) => {
                        setNameAr(v);
                        write.reset();
                    }}
                />
                <button
                    type="button"
                    onClick={add}
                    disabled={!nameAr.trim() || write.busy}
                    aria-busy={write.busy}
                    className="bg-ink fz-12 rad-12 h-54 shrink-0 px-12 font-medium text-white disabled:opacity-50"
                >
                    {write.busy ? t('adding') : t('add', { code })}
                </button>
            </div>
            <FormError message={write.message} attempt={write.attempt} />
        </div>
    );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FormError } from '@/components/ui/FormError';
import { closeUnitAction, reopenCountryAction } from '../actions';
import { useWrite } from '../use-write';
import { Field } from './AddCountryDrawer';

/**
 * Closing a country or region (answers 2026-11-05 §4): a reason, then
 * `country.close` / `region.close`. Nothing is deleted — RDB keeps it, with
 * its history. A closed country stays in the tree, greyed and read-only, and
 * can be reopened (`ReopenCountry`); a closed region leaves the tree.
 *
 * RDB closes from the bottom up and never closes what is below, so the button
 * is off while the tree shows something inside; RDB's own
 * `409 UNIT_HAS_ACTIVE_CHILDREN` (a branch, which the tree does not show)
 * is the backstop.
 */
export function CloseUnit({
    kind,
    id,
    name,
    levelName,
    hasChildren,
    childCount = 0,
    onClosed,
}: {
    kind: 'country' | 'region';
    id: string;
    name: string;
    levelName?: string;
    hasChildren: boolean;
    /** How many are still open directly inside — said in the note. */
    childCount?: number;
    onClosed: () => void;
}) {
    const t = useTranslations('region.close');
    const write = useWrite();
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState('');

    async function close() {
        const done = await write.run((resume) => closeUnitAction({ kind, id, reason: reason.trim() }, resume));
        if (done) onClosed();
    }

    const label = kind === 'country' ? t('country') : t('region', { level: levelName ?? '' });

    return (
        <div className="flex shrink-0 flex-col gap-8">
            {!open ? (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    disabled={hasChildren}
                    className="fz-14 self-start font-medium text-red-500 disabled:opacity-50"
                >
                    {label}
                </button>
            ) : (
                <>
                    <span className="fz-12 text-muted">{t('note')}</span>
                    <Field
                        label={t('reason')}
                        value={reason}
                        maxLength={500}
                        onChange={(v) => {
                            setReason(v);
                            write.reset();
                        }}
                    />
                    <div className="flex gap-8">
                        <button
                            type="button"
                            onClick={() => {
                                setOpen(false);
                                write.reset(true);
                            }}
                            disabled={write.busy}
                            className="bg-surface fz-14 rad-12 text-ink h-50 w-110 shrink-0 font-medium disabled:opacity-50"
                        >
                            {t('cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={close}
                            disabled={!reason.trim() || write.busy}
                            aria-busy={write.busy}
                            className="fz-14 rad-12 h-50 flex-1 bg-red-500 font-medium text-white disabled:opacity-50"
                        >
                            {t('confirm', { name })}
                        </button>
                    </div>
                </>
            )}
            {hasChildren && !open && <span className="fz-12 text-muted">{t('blocked', { count: childCount })}</span>}
            <FormError message={write.message} attempt={write.attempt} />
        </div>
    );
}

/**
 * Reopening a closed country (answers 2026-11-05 §4): a reason, then
 * `country.reopen`. Shown only while `/operations` lists it. A closed country
 * is read-only (2026-11-08 closed-country note) — this is the one thing its
 * sheet offers. What was closed below it stays closed.
 */
export function ReopenCountry({
    id,
    name,
    onReopened,
}: {
    id: string;
    name: string;
    onReopened: (updatedAt?: string) => void;
}) {
    const t = useTranslations('region.reopen');
    const write = useWrite();
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState('');

    async function reopen() {
        const ok = await write.runOk((resume) =>
            reopenCountryAction({ kind: 'country', id, reason: reason.trim() }, resume),
        );
        if (ok) onReopened(ok.updatedAt);
    }

    return (
        <div className="flex shrink-0 flex-col gap-8">
            {!open ? (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="bg-primary fz-14 rad-12 h-50 font-medium text-white"
                >
                    {t('country')}
                </button>
            ) : (
                <>
                    <span className="fz-12 text-muted">{t('note')}</span>
                    <Field
                        label={t('reason')}
                        value={reason}
                        maxLength={500}
                        onChange={(v) => {
                            setReason(v);
                            write.reset();
                        }}
                    />
                    <div className="flex gap-8">
                        <button
                            type="button"
                            onClick={() => {
                                setOpen(false);
                                write.reset(true);
                            }}
                            disabled={write.busy}
                            className="bg-surface fz-14 rad-12 text-ink h-50 w-110 shrink-0 font-medium disabled:opacity-50"
                        >
                            {t('cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={reopen}
                            disabled={!reason.trim() || write.busy}
                            aria-busy={write.busy}
                            className="bg-primary fz-14 rad-12 h-50 flex-1 font-medium text-white disabled:opacity-50"
                        >
                            {t('confirm', { name })}
                        </button>
                    </div>
                </>
            )}
            <FormError message={write.message} attempt={write.attempt} />
        </div>
    );
}

'use client';

import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { iosEase } from '@/components/motion/presets';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils/cn';
import { DATA_TABS } from '../schema';
import { DATA_ICON } from './Settings';
import { PanelTitle } from './parts';

/*
 * A level's panel while the server reads it: the design itself — every title
 * and icon real ("Dashboard Availability", "Dashboard Type", …), the same grey
 * boxes, round choices and chips — with a sweeping bar where each value will
 * be. Never the word "Loading". The rows rise in one after another on the
 * app's iOS curve.
 */

export type SkeletonTab = 'info' | 'settings' | 'login' | 'data';

/** A value still on its way: a short sweeping bar. */
function Bar({ className }: { className?: string }) {
    return <span aria-hidden className={cn('skeleton block h-8 rad-5', className)} />;
}

/** One row of the panel, rising into place after the one before it. */
function Rise({ i, children }: { i: number; children: ReactNode }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...iosEase, delay: i * 0.04 }}
            className="flex flex-col gap-6"
        >
            {children}
        </motion.div>
    );
}

/** A grey box with its real label and the choices as rings with bars beside them. */
function ChoicesBox({ label, count }: { label?: string; count: number }) {
    return (
        <div className="bg-surface rad-12 flex flex-col gap-6 px-12 py-8">
            {label && <span className="fz-10 text-muted">{label}</span>}
            <div className="flex flex-wrap gap-x-16 gap-y-6">
                {Array.from({ length: count }, (_, i) => (
                    <span key={i} className="flex items-center gap-6">
                        <span className="h-12 w-12 shrink-0 rounded-full" style={{ boxShadow: 'inset 0 0 0 0.0625rem #c3c3c3' }} />
                        <Bar className={i % 2 ? 'w-60' : 'w-80'} />
                    </span>
                ))}
            </div>
        </div>
    );
}

/** A label-over-value field: the label real, the value a bar. */
function Field({ label }: { label: string }) {
    return (
        <div className="bg-surface rad-12 flex min-h-50 flex-col justify-center gap-6 px-12 py-8">
            <span className="fz-10 text-muted">{label}</span>
            <Bar className="w-140" />
        </div>
    );
}

/** The short chip and the name beside it (Dashboard Type, a business admin's row). */
function ShortRow({ wide }: { wide?: boolean }) {
    return (
        <div className="flex gap-4">
            <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                <Bar className="w-20" />
            </span>
            {wide && (
                <span className="bg-surface rad-12 grid h-50 w-50 shrink-0 place-items-center">
                    <Bar className="w-20" />
                </span>
            )}
            <span className="bg-surface rad-12 flex h-50 flex-1 items-center px-12">
                <Bar className="w-140" />
            </span>
        </div>
    );
}

export function PanelSkeleton({ tab, showLink = true }: { tab: SkeletonTab; showLink?: boolean }) {
    const ti = useTranslations('work.info');
    const ta = useTranslations('work.access');
    const tl = useTranslations('work.admins');
    const td = useTranslations('work.data');

    const rows: ReactNode[] =
        tab === 'info'
            ? [
                  <>
                      <PanelTitle>{ti('availability')}</PanelTitle>
                      <ChoicesBox label={ti('countries')} count={2} />
                  </>,
                  <Field key="seats" label={ti('seats')} />,
                  <>
                      <PanelTitle icon="nav/database">{ti('type')}</PanelTitle>
                      <ShortRow />
                  </>,
                  <>
                      <PanelTitle icon="business/corporate">{ti('workType')}</PanelTitle>
                      <ShortRow />
                  </>,
                  <>
                      <Bar className="w-120" />
                      <div className="flex flex-wrap gap-6">
                          {Array.from({ length: 4 }, (_, i) => (
                              <span key={i} className="bg-surface rad-12 grid h-50 w-50 place-items-center">
                                  <span aria-hidden className="skeleton block h-26 w-26 rad-5" />
                              </span>
                          ))}
                      </div>
                  </>,
              ]
            : tab === 'settings'
              ? [
                    <>
                        <PanelTitle>{ta('title')}</PanelTitle>
                        <ChoicesBox label={ta('linkType')} count={2} />
                    </>,
                    <>
                        <PanelTitle>{ta('firstLogin')}</PanelTitle>
                        <ChoicesBox label={ta('contract')} count={2} />
                    </>,
                    <ChoicesBox key="verification" label={ta('verification')} count={2} />,
                    <>
                        <PanelTitle>{ta('beforeLogin')}</PanelTitle>
                        <ChoicesBox label={ta('loginType')} count={1} />
                    </>,
                    <>
                        <PanelTitle>{ta('loginInfoSend')}</PanelTitle>
                        <ChoicesBox label={ta('sendVia')} count={1} />
                    </>,
                ]
              : tab === 'login'
                ? [
                      <>
                          <PanelTitle>{tl('loginInfo')}</PanelTitle>
                          {showLink && <Field label={tl('link')} />}
                      </>,
                      <>
                          <PanelTitle>{tl('list')}</PanelTitle>
                          <ShortRow wide />
                          <span aria-hidden className="skeleton block h-26 rad-12" />
                      </>,
                  ]
                : [
                      <>
                          <PanelTitle>{td('title')}</PanelTitle>
                          <div aria-disabled className="flex h-50 items-center gap-6 opacity-60">
                              {DATA_TABS.map((id) => (
                                  <span key={id} className="rad-5 grid h-26 w-26 place-items-center">
                                      <Icon name={DATA_ICON[id]} size={16} mask className="text-[#8D8D8D]" />
                                  </span>
                              ))}
                          </div>
                      </>,
                      <>
                          <Bar className="w-140" />
                          <ChoicesBox count={5} />
                      </>,
                      <>
                          <Bar className="w-120" />
                          <ChoicesBox count={3} />
                      </>,
                  ];

    return (
        <div aria-busy className="flex flex-1 flex-col gap-8 overflow-hidden px-4 pt-4">
            {rows.map((row, i) => (
                <Rise key={i} i={i}>
                    {row}
                </Rise>
            ))}
        </div>
    );
}

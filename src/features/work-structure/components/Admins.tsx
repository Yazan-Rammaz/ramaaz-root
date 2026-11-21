'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { motion, useDragControls } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { FormError } from '@/components/ui/FormError';
import { Icon } from '@/components/ui/Icon';
import { iosEase } from '@/components/motion/presets';
import { cn } from '@/lib/utils/cn';
import {
    addMemberAction,
    decideAppointmentAction,
    decideLoginAction,
    getStartedAction,
    readSecretWordsAction,
    saveMemberCountriesAction,
    type SecretWordsRead,
    setMemberPhotoAction,
    setSecretWordsAction,
    updateMemberAction,
} from '../actions';
import { useLockWhenLocked } from '@/features/auth/use-lock-when-locked';
import { flagEmoji, resolveFlag } from '@/features/region/mock-geo';
import { evidenceSrc, memberPhotoSrc, photoToDataUrl } from '../photo';
import type { AdminStage, BusinessAdmin, ContractTemplate, GrantRole, Level, LoginApproval, Policy, TimelineEvent } from '../schema';
import { pickName } from '../timeline';
import { useWorkWrite } from '../use-work-write';
import { Choice, ChoiceBox, DashedInput, InfoField, OneOf, PanelTitle } from './parts';

/*
 * A level's business admins (XD "Root Dashboard home page" 18–33): the list
 * on Login Info, each with where it stands — a coloured line that opens its
 * log and, where the next step is Root's, does it — the Add Business Admin
 * sheet, Send Login Info, the second root's decision, and the review of the
 * files a first sign-in collected.
 *
 * Every state comes from the backend (`api.ts` puts a person together from
 * their grant, the pending appointment, their first sign-in and their
 * timeline); every write ends in a page refresh that reads it again.
 *
 * Gone on purpose (2026-11-15-design-rules.md §1): the MAC address, the
 * device and the IPs of the Add sheet. A browser cannot read a MAC address,
 * binding a person to a device is not something the server knows, and the
 * addresses a link opens from are the unit's sign-in policy (Settings).
 */

/** The coloured line under an admin, per stage (frames 19, 23, 24, 25, 26). */
const STAGE_STYLE: Record<Exclude<AdminStage, 'active'>, { bg: string; icon?: string }> = {
    approval: { bg: '#fdf3c4' },
    send: { bg: '#d4fbff', icon: 'work/send' },
    login: { bg: '#fdf9c4' },
    review: { bg: '#cfe6ff' },
};

const DASHED = {
    outline: '0.0625rem dashed #bcd8ff',
    outlineOffset: '-0.0625rem',
} as CSSProperties;

/**
 * A person's photo, or the avatar glyph while there is none (or it cannot be
 * loaded). `size` is the square box in XD px; `glyph` the avatar inside it
 * (the whole box unless given).
 */
export function AdminPhoto({ src, size, glyph = size, className }: { src?: string; size: number; glyph?: number; className?: string }) {
    const [broken, setBroken] = useState<string | null>(null);
    const box = { width: `${size * 0.0625}rem`, height: `${size * 0.0625}rem` };
    return src && broken !== src ? (
        // A photo from our own origin (`/api/work-image`) or a picked file — content, not an icon.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" style={box} onError={() => setBroken(src)} className={cn('shrink-0 object-cover', className)} />
    ) : (
        <span style={box} className={cn('grid shrink-0 place-items-center overflow-hidden bg-surface', className)}>
            <Icon name="side/avatar" width={glyph} height={glyph} />
        </span>
    );
}

/** The admin's row: photo, badge, name — and a check once their files wait (grey) or they are in (blue). */
export function AdminRow({ admin, onOpen, photoVersion }: { admin: BusinessAdmin; onOpen?: () => void; photoVersion?: number }) {
    const done = admin.stage === 'active';
    return (
        <div className="flex gap-4">
            <AdminPhoto
                src={admin.hasPhoto ? memberPhotoSrc(admin.id, photoVersion) : undefined}
                // The same 50 × 50 box as the badge beside it.
                size={50}
                glyph={34}
                className="rad-12"
            />
            <span className="grid h-50 w-50 shrink-0 place-items-center rad-12 bg-surface fz-12 text-ink">{admin.short}</span>
            <button
                type="button"
                onClick={onOpen}
                disabled={!onOpen}
                className="flex h-50 min-w-0 flex-1 items-center justify-between gap-8 rad-12 bg-surface px-12 text-start fz-12 text-ink disabled:cursor-default"
            >
                <span className="truncate">{admin.name}</span>
                {(admin.stage === 'review' || done) && <Icon name={done ? 'work/check-on' : 'work/check-off'} size={14} className="shrink-0" />}
            </button>
        </div>
    );
}

/** "40 Ms", "40 S", "2 M", "1 H" — a wait, as XD work structure 9–13 writes it. */
function shortWait(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} Ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} S`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} M`;
    return `${Math.round(m / 60)} H`;
}

/** "13:04" — an event's time of day. */
function clockOf(iso?: string | null): string {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
        ? d.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
          })
        : '';
}

/** Now, ticking once a second — for a wait that is still running. */
function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return now;
}

type Line = {
    text: string;
    at?: string;
    wait?: string;
    failed?: boolean;
    detail?: string;
    sub?: Line[];
};

/**
 * An admin's progress, as XD work structure 9, 11 and 13 draw it:
 *
 *   Send Approval Request To Root Admin "…"           13:01
 *   Waiting Approval From Root Admin "…"              40 S
 *   Approved By Root Admin "…"                        13:02
 *   Waiting Send Login Information To Business Admin  2 M
 *   Send Login Information To Business Admin "Whatsapp" 13:04
 *   Waiting Business Admin Login                      1 S
 *       Delivered To Whatsapp "13:05"
 *       Waiting Read On Whatsapp "40 Ms"   …
 *   Full Duration 30 M
 *   User Side … · System Side … · Approval Side …
 *
 * The first four lines come from the general-manager appointment (§5.11:
 * requested, decided); the rest from the onboarding timeline (§5.16), which
 * starts at the Get Started message. Every time is the backend's.
 */
export function AdminLog({ admin }: { admin: BusinessAdmin }) {
    const t = useTranslations('work.log');
    // The backend's codes are open-ended: a kind, stage or purpose we have no words for shows as sent.
    const say = t as unknown as ((key: string, values?: Record<string, string>) => string) & { has: (key: string) => boolean };
    const word = (key: string, fallback: string) => (say.has(key) ? say(key) : fallback);
    const label = (e: TimelineEvent) => {
        const what = e.stage ? word(`stage.${e.stage}`, e.stage) : e.purpose ? word(`purpose.${e.purpose}`, e.purpose) : '';
        return say.has(`kind.${e.kind}`) ? say(`kind.${e.kind}`, { what, detail: e.detail ?? '' }) : e.kind;
    };

    const appointment = admin.approval ?? admin.appointment;
    const timeline = admin.timeline;
    const events = timeline?.events ?? [];
    const running = appointment?.status === 'PENDING' || timeline?.status === 'IN_PROGRESS';
    const now = useNow(running);
    const at = (iso?: string | null) => (iso ? Date.parse(iso) : NaN);
    const quoted = (name?: string) => (name ? `"${name}"` : '');

    const lines: Line[] = [];
    if (appointment) {
        // Who decides: named while it waits (`decider`), and who did once decided.
        const decider = quoted(appointment.decided_by?.full_name ?? appointment.decider?.full_name);
        lines.push({
            text: t('approvalSent', { name: decider }),
            at: clockOf(appointment.requested_at),
        });
        if (appointment.status === 'PENDING') {
            lines.push({
                text: t('approvalWaiting', { name: decider }),
                wait: shortWait(now - at(appointment.requested_at)),
            });
        } else if (appointment.decided_at) {
            lines.push({
                text: t('approvalWaiting', { name: decider }),
                wait: shortWait(at(appointment.decided_at) - at(appointment.requested_at)),
            });
            lines.push({
                text: t('approvedBy', { name: decider }),
                at: clockOf(appointment.decided_at),
            });
        }
    }

    // The Get Started message: the line that opens the person's own part.
    const sentIndex = events.findLastIndex((e) => e.kind === 'MESSAGE_SENT' && e.purpose === 'GET_STARTED');
    if (appointment && appointment.status !== 'PENDING' && appointment.decided_at) {
        const sentAt = sentIndex >= 0 ? at(events[sentIndex].at) : now;
        lines.push({
            text: t('waitingSend'),
            wait: shortWait(sentAt - at(appointment.decided_at)),
        });
    }

    if (sentIndex >= 0) {
        const sent = events[sentIndex];
        lines.push({
            // The channel the backend recorded; WhatsApp is the only one Get Started uses.
            text: t('sentVia', { channel: sent.channel && sent.channel !== 'whatsapp' ? sent.channel : t('whatsapp') }),
            at: clockOf(sent.at),
        });
        // Everything after it, alternating the wait and the event it was waiting for.
        const sub: Line[] = [];
        let previous = sent;
        for (const e of events.slice(sentIndex + 1)) {
            if (previous.duration_ms)
                sub.push({
                    text: `${t('waiting', { what: label(e) })} "${shortWait(previous.duration_ms)}"`,
                });
            sub.push({
                text: `${label(e)}${e.at ? ` "${clockOf(e.at)}"` : ''}`,
                failed: e.kind === 'MESSAGE_FAILED',
                detail: e.kind === 'MESSAGE_FAILED' ? e.detail : undefined,
            });
            previous = e;
        }
        const end = timeline?.completed_at ? at(timeline.completed_at) : now;
        lines.push({
            text: t('waitingLogin'),
            wait: shortWait(end - at(sent.at)),
            sub,
        });
    } else {
        // No Get Started on record (a root's own sign-in): the events as they come.
        for (const e of events) {
            lines.push({
                text: label(e),
                at: clockOf(e.at),
                wait: e.duration_ms ? shortWait(e.duration_ms) : undefined,
                failed: e.kind === 'MESSAGE_FAILED',
                detail: e.kind === 'MESSAGE_FAILED' ? e.detail : undefined,
            });
        }
    }

    if (lines.length === 0) return <span className="px-12 fz-10 text-muted">{t('empty')}</span>;
    const totals = timeline?.totals;
    return (
        <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2 rad-12 bg-surface px-12 py-6">
                {lines.map((l, i) => (
                    <li key={i} className="flex flex-col fz-8">
                        <span className={cn('flex justify-between gap-8', l.failed ? 'text-red-500' : 'text-ink')}>
                            <span>• {l.text}</span>
                            <span className="shrink-0 text-muted">{l.at ?? l.wait}</span>
                        </span>
                        {l.detail && <span className="ps-8 break-words text-muted">{l.detail}</span>}
                        {l.sub && l.sub.length > 0 && (
                            <ul className="flex flex-col ps-12">
                                {l.sub.map((s, j) => (
                                    <li key={j} className={cn('fz-8', s.failed ? 'text-red-500' : 'text-ink')}>
                                        • {s.text}
                                        {s.detail && <span className="block ps-8 break-words text-muted">{s.detail}</span>}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </li>
                ))}
            </ul>
            {/* The totals close the log, as the design has them. */}
            {totals && (
                <span className="flex flex-col px-12 fz-10 text-ink">
                    <span>{t('total', { total: shortWait(totals.total_ms) })}</span>
                    <span className="text-muted">
                        {t('split', {
                            person: shortWait(totals.person_ms),
                            system: shortWait(totals.system_ms),
                            approver: shortWait(totals.approver_ms),
                        })}
                    </span>
                </span>
            )}
        </div>
    );
}

/** The coloured line under an admin and its log (⋮ opens it). `onAct` is the line's own step, where it has one. */
function StageLine({ admin, onAct, onShowFile }: { admin: BusinessAdmin; onAct?: () => void; onShowFile: () => void }) {
    const t = useTranslations('work.admins');
    const [open, setOpen] = useState(false);
    const waitingSince = admin.stage === 'approval' && admin.approval ? Date.parse(admin.approval.requested_at) : NaN;
    const ticking = useNow(!Number.isNaN(waitingSince));
    if (admin.stage === 'active') return null;
    const style = STAGE_STYLE[admin.stage];
    // One wording for both roots (XD work structure 8); only what a tap does
    // differs. The approval line carries how long it has been waiting.
    const label = Number.isNaN(waitingSince)
        ? t(`stage.${admin.stage}`)
        : `${t('stage.approval')} "${shortWait(ticking - waitingSince).toLowerCase()}"`;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex h-22 items-center rad-10 px-12 fz-10 text-ink" style={{ backgroundColor: style.bg }}>
                <button
                    type="button"
                    onClick={onAct}
                    disabled={!onAct}
                    className="flex flex-1 items-center justify-center gap-6 disabled:cursor-default"
                >
                    {style.icon && <Icon name={style.icon} size={10} mask />}
                    {label}
                </button>
                <button
                    type="button"
                    onClick={() => setOpen((o) => !o)}
                    aria-expanded={open}
                    aria-label={t('log')}
                    className="shrink-0 fz-12 leading-none"
                >
                    {open ? '••' : '⋮'}
                </button>
            </div>
            {/* Nothing reached them: say so, in the error colour, over "Send Login Info". */}
            {admin.stage === 'send' && admin.deliveryFailed && <span className="px-12 fz-10 text-red-500">{t('notDelivered')}</span>}
            {admin.stage === 'review' && (
                <button type="button" onClick={onShowFile} className="h-22 rad-10 bg-surface fz-10 text-ink">
                    {t('showFile')}
                </button>
            )}
            {open && <AdminLog admin={admin} />}
        </div>
    );
}

export type AdminStep = 'appointment' | 'send' | 'review';

/** Login Info: the level's admins, each with where it stands. */
export function LoginInfo({
    link,
    admins,
    unavailable,
    onOpenAdmin,
    onStep,
}: {
    /** Where this level's business admins sign in — the Management console's address. */
    link?: string;
    admins: BusinessAdmin[];
    unavailable: boolean;
    onOpenAdmin: (id: string) => void;
    onStep: (step: AdminStep, id: string) => void;
}) {
    const t = useTranslations('work.admins');
    return (
        <div className="flex flex-col gap-8">
            {/* XD work structure 5: the dashboard's link first. */}
            <PanelTitle>{t('loginInfo')}</PanelTitle>
            {link && (
                <InfoField
                    label={t('link')}
                    value={
                        <a href={`https://${link}`} target="_blank" rel="noreferrer" className="text-primary">
                            {link}
                        </a>
                    }
                />
            )}
            {unavailable ? (
                <span className="fz-10 text-muted">{t('unavailable')}</span>
            ) : admins.length === 0 ? null : (
                <>
                    <PanelTitle>{t('list')}</PanelTitle>
                    {admins.map((a) => (
                        <div key={a.id} className="flex flex-col gap-4">
                            <AdminRow admin={a} onOpen={a.stage === 'approval' ? undefined : () => onOpenAdmin(a.id)} />
                            <StageLine
                                admin={a}
                                onAct={
                                    a.stage === 'approval' && a.approval
                                        ? () => onStep('appointment', a.id)
                                        : a.stage === 'send'
                                          ? () => onStep('send', a.id)
                                          : a.stage === 'review' && a.loginApproval?.may_decide
                                            ? () => onStep('review', a.id)
                                            : undefined
                                }
                                onShowFile={() => onStep('review', a.id)}
                            />
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}

/** The dashed "Add Business Admin" pinned at the bottom of Login Info. */
export function AddAdminButton({ onClick }: { onClick: () => void }) {
    const t = useTranslations('work.admins');
    return (
        <button
            type="button"
            onClick={onClick}
            // 406 × 50, #fcfcfc, radius 12 (XD), the light-blue line around it.
            className="hairline mx-auto h-50 w-406 max-w-full shrink-0 rad-12 bg-surface fz-12 text-ink"
            style={
                {
                    '--hairline-radius': '0.75rem',
                    '--hairline-color': '#bcd8ff',
                } as CSSProperties
            }
        >
            {t('add')}
        </button>
    );
}

/* ───────────────────────────── Sheets ───────────────────────────── */

/**
 * A sheet that rises over the dimmed panel and closes with a swipe down — far
 * enough (a third of the way) or fast enough. The drag starts only from the
 * grab bar on top, so typing in its fields and scrolling it still work.
 */
function SwipeSheet({ onClose, className, children }: { onClose: () => void; className?: string; children: ReactNode }) {
    const controls = useDragControls();
    return (
        <motion.div
            drag="y"
            dragListener={false}
            dragControls={controls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.9 }}
            onDragEnd={(_, info) => {
                if (info.offset.y > 160 || info.velocity.y > 700) onClose();
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            transition={iosEase}
            className={cn('flex flex-1 flex-col overflow-hidden bg-background shadow-sm', className)}
            // A sheet rising from the bottom edge: only its TOP corners round (20 XD px);
            // the bottom sits square on the panel's edge.
            style={{
                borderTopLeftRadius: '1.25rem',
                borderTopRightRadius: '1.25rem',
            }}
        >
            {/* The grab bar — drag only; the navbar's X closes it without a swipe. */}
            <div
                aria-hidden
                onPointerDown={(e) => controls.start(e)}
                className="flex h-20 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
            >
                <span className="h-4 w-40 rounded-full bg-muted opacity-60" />
            </div>
            {children}
        </motion.div>
    );
}

/** The sheet's main button: 406 × 50, #3066cc, radius 12 (XD). */
function PrimaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="mx-auto flex h-50 w-406 max-w-full shrink-0 items-center justify-center gap-6 rad-12 bg-primary fz-12 text-white disabled:opacity-60"
        >
            {children}
        </button>
    );
}

/** A dashed secondary button (Refuse, Withdraw, Remove). */
function QuietButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="h-36 shrink-0 rad-12 px-12 fz-12 text-primary disabled:opacity-60"
            style={DASHED}
        >
            {children}
        </button>
    );
}

/**
 * The photo box: the picture that the person's face is compared with at every
 * sign-in — so it says so. A picked file is shrunk to a JPEG here
 * (`photoToDataUrl`) before it is held or sent.
 */
function PhotoPicker({ src, onPick, label, size = 240 }: { src?: string; onPick: (dataUrl: string) => void; label: string; size?: number }) {
    const t = useTranslations('work.admins.sheet');
    const [failed, setFailed] = useState(false);
    return (
        <div className="flex flex-col items-center gap-4">
            <label
                className="relative block cursor-pointer overflow-hidden rad-24"
                style={{ width: `${size * 0.0625}rem`, height: `${size * 0.0625}rem` }}
            >
                <AdminPhoto src={src} size={size} className="rad-24" />
                <span className="absolute inset-x-0 bottom-0 flex h-32 items-center justify-center gap-6 bg-black/85 fz-12 text-white">
                    <Icon name="work/photo" size={14} mask />
                    {label}
                </span>
                <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        try {
                            setFailed(false);
                            onPick(await photoToDataUrl(file));
                        } catch {
                            setFailed(true);
                        }
                    }}
                />
            </label>
            <span className="text-center fz-10 text-muted">{t('photoUse')}</span>
            <FormError message={failed ? t('photoUnreadable') : undefined} />
        </div>
    );
}

/* ───────────────────────────── Add ───────────────────────────── */

/**
 * The secret words typed on Add Business Admin (XD work structure 6), carried
 * to that person's Send Login Info, which is where the backend takes them: it
 * sends them in the same WhatsApp message as the link and the code
 * (console-api.md §5.10). Kept in THIS tab only (sessionStorage) and dropped
 * once sent. ⏳ The backend has been asked to take them on Add instead
 * (2026-11-21-work-structure-add-admin.md), so they survive a closed tab.
 */
const wordsKey = (userId: string) => `ws_words_${userId}`;
function keepWords(userId: string, words: string) {
    try {
        sessionStorage.setItem(wordsKey(userId), words);
    } catch {
        /* storage unavailable: the Send step asks for them again */
    }
}
function takeWords(userId: string): string {
    try {
        return sessionStorage.getItem(wordsKey(userId)) ?? '';
    } catch {
        return '';
    }
}
function dropWords(userId: string) {
    try {
        sessionStorage.removeItem(wordsKey(userId));
    } catch {
        /* nothing to do */
    }
}

/**
 * Add Business Admin (frames 20–21), as designed: the photo, the name exactly
 * as on their ID, and the phone. They are this level's business admin, so the
 * role is not asked for: it is the most senior role that may be held here
 * (rank 1, "Business Admin"). At the head office it goes to the other root for
 * approval first.
 */
export function AddAdminSheet({ level, roles, onDone, onClose }: { level: Level; roles: GrantRole[]; onDone: () => void; onClose: () => void }) {
    const t = useTranslations('work.admins');
    const write = useWorkWrite();
    const [photo, setPhoto] = useState<string>();
    const [f, setF] = useState({ name: '', phone: '', words: '' });
    const set = (k: keyof typeof f) => (v: string) => {
        write.reset();
        setF((x) => ({ ...x, [k]: v }));
    };
    const role = roles[0];
    const ready = !!f.name.trim() && !!f.phone.trim() && !!role && !write.busy;
    const field = (k: string) => write.result.fields?.[k];

    return (
        <SwipeSheet onClose={onClose} className="gap-8 px-8 pb-12">
            <span className="text-center fz-10 text-ink">{t('sheet.title')}</span>
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto">
                <PhotoPicker src={photo} onPick={setPhoto} label={photo ? t('sheet.editPhoto') : t('sheet.addPhoto')} />
                <DashedInput label={t('sheet.name')} value={f.name} onChange={set('name')} />
                <FieldError message={field('full_name')} />
                <DashedInput label={t('sheet.phone')} value={f.phone} onChange={set('phone')} />
                <FieldError message={field('phone')} />
                <DashedInput label={t('sheet.secret')} value={f.words} onChange={set('words')} />
            </div>
            {/* No role may be held here yet: the roles screen has none for this level. */}
            <FormError message={write.result.error ?? (role ? undefined : t('sheet.noRoles'))} attempt={write.result} />
            {ready && (
                <PrimaryButton
                    onClick={async () => {
                        const r = await write.run(() =>
                            addMemberAction(level, { full_name: f.name, phone: f.phone, secret_words: f.words.trim() || undefined, roles: [role.id] }, photo),
                        );
                        if (r?.ok) {
                            // Kept in the tab only when the backend did not take them on Add.
                            if (r.userId && r.wordsInTab && f.words.trim()) keepWords(r.userId, f.words.trim());
                            onDone();
                        }
                    }}
                >
                    ↳ {t('add')}
                </PrimaryButton>
            )}
        </SwipeSheet>
    );
}

/** A passing line saying what happened — not an error, so not `<FormError>`. */
export function Notice({ message }: { message?: string }) {
    return message ? <span className="text-center fz-12 text-muted">{message}</span> : null;
}

function FieldError({ message }: { message?: string }) {
    return message ? <span className="px-12 fz-10 text-red-500">{message}</span> : null;
}

/* ───────────────────────────── Send Login Info ───────────────────────────── */

/**
 * Send Login Info (Get Started, §5.8): the link and private code by WhatsApp.
 * The reference photo has to be in place first wherever the face check is on —
 * the server does not stop it, so this sheet does. Secret words, when given,
 * go in the same message; the contract is the one they sign at first sign-in.
 */
export function GetStartedSheet({
    admin,
    policy,
    templates,
    onDone,
    onClose,
}: {
    admin: BusinessAdmin;
    policy: Policy | null;
    templates: ContractTemplate[];
    onDone: (notice?: string) => void;
    onClose: () => void;
}) {
    const t = useTranslations('work.send');
    const photoWrite = useWorkWrite();
    const write = useWorkWrite();
    const [version, setVersion] = useState(0);
    // Prefilled with the words typed on Add, when this tab still has them.
    const [words, setWords] = useState(() => takeWords(admin.id));
    const effective = policy?.effective;
    const allowed = effective?.contract_types?.length ? templates.filter((x) => effective.contract_types!.includes(x.code)) : templates;
    const contractRequired = effective?.require_contract ?? false;
    const [contract, setContract] = useState<string>(contractRequired && allowed[0] ? allowed[0].code : '');
    // Unknown policy reads as "face on": the safe side of a rule the screen keeps.
    const photoNeeded = !admin.hasPhoto && (effective?.require_face ?? true);
    const ready = !photoNeeded && (!contractRequired || !!contract) && !write.busy;

    return (
        <SwipeSheet onClose={onClose} className="gap-8 px-8 pb-12">
            <span className="text-center fz-10 text-ink">{t('title', { name: admin.name })}</span>
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto">
                <PhotoPicker
                    size={136}
                    src={admin.hasPhoto ? memberPhotoSrc(admin.id, version) : undefined}
                    label={admin.hasPhoto ? t('changePhoto') : t('addPhoto')}
                    onPick={async (dataUrl) => {
                        const r = await photoWrite.run(() => setMemberPhotoAction(admin.id, dataUrl));
                        if (r?.ok) setVersion((v) => v + 1);
                    }}
                />
                <FormError message={photoWrite.result.error} attempt={photoWrite.result} />
                {photoNeeded && <span className="text-center fz-10 text-red-500">{t('photoFirst')}</span>}
                <DashedInput label={t('secretWords')} value={words} onChange={(v) => (write.reset(), setWords(v))} />
                <span className="px-12 fz-10 text-muted">{t('secretWordsHint')}</span>
                <FieldError message={write.result.fields?.secret_words} />
                <ChoiceBox label={contractRequired ? t('contractRequired') : t('contract')}>
                    {allowed.length === 0 ? (
                        <span className="fz-10 text-muted">{t('noTemplates')}</span>
                    ) : (
                        <OneOf
                            options={[...(contractRequired ? [] : ['']), ...allowed.map((x) => x.code)]}
                            value={contract}
                            label={(code) => {
                                const tpl = allowed.find((x) => x.code === code);
                                return tpl ? `${tpl.title} · ${tpl.version}` : t('noContract');
                            }}
                            onChange={(code) => (write.reset(), setContract(code))}
                        />
                    )}
                </ChoiceBox>
                <FieldError message={write.result.fields?.contract_type} />
            </div>
            <FormError message={write.result.error} attempt={write.result} />
            <PrimaryButton
                disabled={!ready}
                onClick={async () => {
                    const r = await write.run(() =>
                        getStartedAction(admin.id, {
                            secret_words: words.trim() || undefined,
                            contract_type: contract || undefined,
                        }),
                    );
                    if (r?.ok) {
                        dropWords(admin.id);
                        onDone(r.notice);
                    }
                }}
            >
                <Icon name="work/send" size={14} mask />
                {t('send')}
            </PrimaryButton>
        </SwipeSheet>
    );
}

/* ───────────────────────────── The second root ───────────────────────────── */

/** "BA · Business Admin, …" for one side of an appointment. */
function rolesLine(roles: GrantRole[] | undefined, locale: string, none: string) {
    return roles?.length ? roles.map((r) => `${r.short_name} · ${pickName(r.name, locale)}`).join(', ') : none;
}

/**
 * A general-manager appointment (§5.11): what approving would give beside
 * what they hold now. The other root approves or refuses; the root who asked
 * can only withdraw it.
 */
export function AppointmentSheet({ admin, onDone, onClose }: { admin: BusinessAdmin; onDone: () => void; onClose: () => void }) {
    const t = useTranslations('work.appointment');
    const locale = useLocale();
    const write = useWorkWrite();
    const [reason, setReason] = useState('');
    const a = admin.approval;
    if (!a) return null;
    const head = (g: typeof a.proposed) => (g?.assignments ?? []).filter((x) => x.unit === null).flatMap((x) => x.roles);
    const decide = async (d: 'approve' | 'refuse' | 'withdraw') => {
        const r = await write.run(() => decideAppointmentAction(a.id, d, { payloadHash: a.payload_hash, reason }));
        if (r?.ok || r?.reload) onDone();
    };

    return (
        <SwipeSheet onClose={onClose} className="gap-8 px-8 pb-12">
            <span className="text-center fz-10 text-ink">{t('title', { name: a.target.full_name })}</span>
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto">
                <InfoField label={t('requestedBy')} value={`${a.requested_by.full_name} · ${new Date(a.requested_at).toLocaleString()}`} />
                {a.expires_at && <InfoField label={t('expires')} value={new Date(a.expires_at).toLocaleString()} />}
                <InfoField label={t('proposed')} value={rolesLine(head(a.proposed), locale, t('nothing'))} />
                <InfoField label={t('current')} value={rolesLine(head(a.current), locale, t('nothing'))} />
                {a.may_decide && <DashedInput label={t('reason')} value={reason} onChange={(v) => (write.reset(), setReason(v))} />}
                {!a.may_decide && <span className="text-center fz-10 text-muted">{t('otherRootDecides')}</span>}
            </div>
            <FormError message={write.result.error} attempt={write.result} />
            {a.may_decide ? (
                <>
                    <PrimaryButton disabled={write.busy} onClick={() => decide('approve')}>
                        {t('approve')}
                    </PrimaryButton>
                    <QuietButton disabled={write.busy} onClick={() => decide('refuse')}>
                        {t('refuse')}
                    </QuietButton>
                </>
            ) : (
                <QuietButton disabled={write.busy} onClick={() => decide('withdraw')}>
                    {t('withdraw')}
                </QuietButton>
            )}
        </SwipeSheet>
    );
}

/* ──────────────────────────── Review ──────────────────────────── */

/** The document's images, 192 × 109 each (XD work structure 20): an ID's two sides, a passport's one page. */
function IdImages({ login }: { login?: LoginApproval }) {
    const doc = login?.evidence?.document;
    const sides = doc?.type === 'PASSPORT' ? (['front'] as const) : (['front', 'back'] as const);
    return (
        <div className="flex justify-between gap-6">
            {sides.map((side) => (
                <span key={side} className="grid h-109 w-192 shrink-0 place-items-center overflow-hidden rad-12 bg-surface">
                    {login && doc?.[`${side}_image_url`] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={evidenceSrc(login.id, side)} alt="" className="h-full w-full object-cover" />
                    ) : (
                        <Icon name="work/id-card" size={26} />
                    )}
                </span>
            ))}
        </div>
    );
}

const DOC_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE'] as const;
const isDocType = (v: string): v is (typeof DOC_TYPES)[number] => (DOC_TYPES as readonly string[]).includes(v);

/** What was read off the identity document (frames 27, 37). */
export function KycFields({ login, birthday }: { login?: LoginApproval; birthday?: boolean }) {
    const t = useTranslations('work.kyc');
    const doc = login?.evidence?.document;
    const k = doc?.extracted;
    if (!doc || !k) return null;
    return (
        <div className="flex flex-col gap-4">
            {doc.type && <InfoField label={t('idType')} value={isDocType(doc.type) ? t(`docType.${doc.type}`) : doc.type} />}
            {k.country && <InfoField label={t('country')} value={k.country} />}
            {k.full_name && <InfoField label={t('name')} value={k.full_name} />}
            {k.national_number && <InfoField label={t('nationalNumber')} value={k.national_number} />}
            {birthday && k.birth_date && <InfoField label={t('birthday')} value={k.birth_date} />}
        </div>
    );
}

/** The reference photograph beside this sign-in's face capture. */
function Faces({ login, admin, size }: { login?: LoginApproval; admin: BusinessAdmin; size: number }) {
    const t = useTranslations('work.kyc');
    const reference = login?.evidence?.reference_photo_url
        ? evidenceSrc(login.id, 'reference')
        : admin.hasPhoto
          ? memberPhotoSrc(admin.id)
          : undefined;
    const capture = login?.evidence?.face_capture_url ? evidenceSrc(login.id, 'capture') : undefined;
    return (
        <div className="flex justify-between gap-6">
            {(
                [
                    ['entered', reference],
                    ['detected', capture],
                ] as const
            ).map(([k, src]) => (
                <div key={k} className="flex flex-col items-center gap-4">
                    <AdminPhoto src={src} size={size} className="rad-20" />
                    <span className="fz-10 text-ink">{t(k)}</span>
                </div>
            ))}
        </div>
    );
}

/**
 * Reviewing what a first sign-in collected, then letting it in (XD work
 * structure 15, §5.12): the face this sign-in was checked on, the document's
 * two sides, what was read off it, and Approve. The design has no Refuse.
 */
export function ReviewSheet({ admin, onDone, onClose }: { admin: BusinessAdmin; onDone: () => void; onClose: () => void }) {
    const t = useTranslations('work.kyc');
    const write = useWorkWrite();
    const login = admin.loginApproval;
    const face = login?.evidence?.face_capture_url
        ? evidenceSrc(login.id, 'capture')
        : login?.evidence?.reference_photo_url
          ? evidenceSrc(login.id, 'reference')
          : admin.hasPhoto
            ? memberPhotoSrc(admin.id)
            : undefined;
    const approve = async () => {
        if (!login) return;
        const r = await write.run(() => decideLoginAction(login.id, 'approve'));
        if (r?.ok || r?.reload) onDone();
    };
    return (
        <SwipeSheet onClose={onClose} className="gap-8 px-8 pb-8">
            <AdminRow admin={admin} />
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto">
                <AdminPhoto src={face} size={240} className="mx-auto rad-24" />
                <IdImages login={login} />
                <KycFields login={login} />
                <ContractTerms contract={admin.contract} />
            </div>
            <FormError message={write.result.error} attempt={write.result} />
            {login?.may_decide && login.status === 'PENDING' && (
                <button
                    type="button"
                    disabled={write.busy}
                    onClick={() => void approve()}
                    className="h-36 w-full shrink-0 rad-12 fz-12 text-primary disabled:opacity-60"
                    style={DASHED}
                >
                    {t('approve')}
                </button>
            )}
        </SwipeSheet>
    );
}

/* ──────────────────────────── One admin (XD work structure 17–20) ──────────────────────────── */

/** "31/07/2026" — a day, as the design writes it. */
function dayOf(iso?: string | null): string {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * A field whose value changes in place: the design's blue Edit opens it, Enter
 * or leaving it saves, Escape puts it back.
 */
function EditableField({
    label,
    value,
    shown,
    editLabel,
    onCommit,
    busy,
    after,
}: {
    label: string;
    value: string;
    /** What the field reads when not being edited (defaults to `value`). */
    shown?: ReactNode;
    editLabel: string;
    onCommit: (next: string) => void;
    busy?: boolean;
    /** A small control at the end of the value (Show). */
    after?: ReactNode;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        const next = draft.trim();
        setDraft(null);
        if (next && next !== value) onCommit(next);
    };
    return (
        <InfoField
            label={label}
            editLabel={editLabel}
            onEdit={draft === null && !busy ? () => setDraft(value) : undefined}
            value={
                draft !== null ? (
                    <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commit();
                            if (e.key === 'Escape') setDraft(null);
                        }}
                        className="w-full bg-transparent outline-none"
                    />
                ) : (
                    <span className="flex items-center justify-between gap-8">
                        <span className="min-w-0 break-words">{shown ?? value}</span>
                        {after}
                    </span>
                )
            }
        />
    );
}

/**
 * Their info (frame 17), on the console's routes:
 *   name, phone   `PATCH …/members/{id}` (§5.8a). A new phone ends every session
 *                 they have and is confirmed at their next sign-in, so it is
 *                 confirmed here first; until that sign-in it reads "new number,
 *                 not yet confirmed".
 *   secret words  read only on Show (`GET …/secret-words`, every read is audited),
 *                 hidden again when the panel closes; Edit is `PUT` (§5.10).
 */
export function AdminInfo({ admin }: { admin: BusinessAdmin }) {
    const t = useTranslations('work.admin');
    const tw = useTranslations('work');
    const write = useWorkWrite();
    const words = useWorkWrite();
    const [now] = useState(() => Date.now());
    const [phoneAsked, setPhoneAsked] = useState<string | null>(null);
    const [read, setRead] = useState<SecretWordsRead | null>(null);
    const [reading, setReading] = useState(false);
    useLockWhenLocked(read ?? {});

    const show = async () => {
        setReading(true);
        try {
            setRead(await readSecretWordsAction(admin.id));
        } finally {
            setReading(false);
        }
    };
    const has = read?.has ?? admin.hasSecretWords;
    const wordsShown = read?.words
        ? `"${read.words}"`
        : read && read.has && !read.readable
          ? t('wordsSetOn', { date: dayOf(read.setAt) || '—' })
          : has === false
            ? t('wordsNotSet')
            : '••••';
    const added = admin.grantedAt ? Date.parse(admin.grantedAt) : NaN;

    return (
        <>
            <PanelTitle>{t('info', { name: admin.name })}</PanelTitle>
            <EditableField
                label={t('name')}
                value={admin.name}
                editLabel={tw('edit')}
                busy={write.busy}
                onCommit={(full_name) => void write.run(() => updateMemberAction(admin.id, { full_name }))}
            />
            <EditableField
                label={t('phone')}
                value={admin.phone ?? ''}
                shown={
                    <>
                        {admin.phone ?? '—'}
                        {admin.phoneUnverified && <span className="fz-10 text-muted ms-6">{t('phoneUnverified')}</span>}
                    </>
                }
                editLabel={tw('edit')}
                busy={write.busy}
                onCommit={(phone) => (write.reset(), setPhoneAsked(phone))}
            />
            {phoneAsked !== null && (
                // A new phone signs them out everywhere: asked before it is sent.
                <div className="bg-surface rad-12 flex flex-col gap-8 px-12 py-8">
                    <span className="fz-10 text-ink">{t('phoneConfirm', { name: admin.name })}</span>
                    <div className="flex justify-center gap-8">
                        <QuietButton
                            disabled={write.busy}
                            onClick={async () => {
                                const r = await write.run(() => updateMemberAction(admin.id, { phone: phoneAsked }));
                                if (r?.ok) setPhoneAsked(null);
                            }}
                        >
                            {t('phoneConfirmYes')}
                        </QuietButton>
                        <QuietButton disabled={write.busy} onClick={() => setPhoneAsked(null)}>
                            {t('cancel')}
                        </QuietButton>
                    </div>
                </div>
            )}
            <FieldError message={write.result.fields?.full_name ?? write.result.fields?.phone} />
            <FormError message={write.result.error} attempt={write.result} />
            <Notice message={write.result.notice} />
            <EditableField
                label={t('secret')}
                value={read?.words ?? ''}
                shown={wordsShown}
                editLabel={tw('edit')}
                busy={words.busy}
                after={
                    has !== false &&
                    !read?.words && (
                        <button type="button" disabled={reading} onClick={() => void show()} className="fz-10 text-primary shrink-0 cursor-pointer">
                            {t('show')}
                        </button>
                    )
                }
                onCommit={async (value) => {
                    const r = await words.run(() => setSecretWordsAction(admin.id, value));
                    if (r?.ok) setRead({ has: true, readable: true, words: value });
                }}
            />
            <FieldError message={words.result.fields?.secret_words} />
            <FormError message={words.result.error ?? read?.error} attempt={words.result} />
            <InfoField label={t('addedBy')} value={admin.addedBy ?? '—'} />
            <InfoField label={t('approvedBy')} value={admin.approvedBy ?? '—'} />
            <InfoField
                label={t('addedAt')}
                value={
                    Number.isNaN(added)
                        ? '—'
                        : `${dayOf(admin.grantedAt)} ${t('daysAgo', { days: Math.max(0, Math.floor((now - added) / 86_400_000)) })}`
                }
            />
        </>
    );
}

/**
 * Their dashboard availability (frame 18), cut as the level's ⚙ tab was
 * (frame 3): only Availability For Countries. It is where this person's roles
 * take effect (§5.10a): Enable is every country; Disable starts from every
 * country unit and a flag is taken off by tapping it. Only Root may change it;
 * leaving nobody a country is asked first.
 */
export function AdminAvailability({ admin, units }: { admin: BusinessAdmin; units: { id: string; code?: string }[] }) {
    const t = useTranslations('work.admin');
    const ti = useTranslations('work.info');
    const write = useWorkWrite();
    const saved = admin.countries;
    const [all, setAll] = useState(saved?.all ?? true);
    const [ids, setIds] = useState<string[]>(saved?.ids ?? []);
    const [askEmpty, setAskEmpty] = useState(false);
    const editable = !!saved?.mayEdit && !write.busy;

    const save = (nextAll: boolean, nextIds: string[]) => {
        setAll(nextAll);
        setIds(nextIds);
        setAskEmpty(false);
        void write.run(() => saveMemberCountriesAction(admin.id, nextAll, nextIds));
    };
    const toggle = (id: string) => {
        const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
        if (next.length === 0) return setAskEmpty(true);
        save(false, next);
    };

    return (
        <>
            <PanelTitle>{t('availability', { name: admin.name })}</PanelTitle>
            <ChoiceBox label={ti('countries')}>
                <div className="flex gap-16">
                    <Choice on={all} label={ti('enable')} disabled={!editable} onChange={() => save(true, [])} />
                    <Choice
                        on={!all}
                        label={ti('disable')}
                        disabled={!editable}
                        onChange={() => all && save(false, units.map((u) => u.id))}
                    />
                </div>
                {!all && (
                    <div className="flex flex-wrap gap-6">
                        {units.map((u) => {
                            const on = ids.includes(u.id);
                            const flag = u.code ? resolveFlag(u.code) : undefined;
                            return (
                                <button
                                    key={u.id}
                                    type="button"
                                    aria-pressed={on}
                                    disabled={!editable}
                                    onClick={() => toggle(u.id)}
                                    className={cn('rad-10 grid h-34 w-34 cursor-pointer place-items-center bg-white disabled:cursor-default', on ? 'hairline' : 'opacity-40')}
                                    style={on ? ({ '--hairline-radius': '0.625rem', '--hairline-color': '#388CFF' } as CSSProperties) : undefined}
                                >
                                    {flag ? (
                                        <Icon name={flag.icon} width={18} height={12} />
                                    ) : (
                                        <span className="fz-14 leading-none">{u.code ? flagEmoji(u.code) : '·'}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}
            </ChoiceBox>
            {askEmpty && (
                <div className="bg-surface rad-12 flex flex-col gap-8 px-12 py-8">
                    <span className="fz-10 text-ink">{t('noAccessConfirm')}</span>
                    <div className="flex justify-center gap-8">
                        <QuietButton onClick={() => save(false, [])}>{t('continue')}</QuietButton>
                        <QuietButton onClick={() => setAskEmpty(false)}>{t('cancel')}</QuietButton>
                    </div>
                </div>
            )}
            <FormError message={write.result.error} attempt={write.result} />
        </>
    );
}

/**
 * LEGALLY BINDING CONTRACT AND TERMS (XD work structure 15, 20): each clause
 * with how the person answered it — I Agree green, I Disagree red — read only.
 */
function ContractTerms({ contract }: { contract?: BusinessAdmin['contract'] }) {
    const t = useTranslations('work.kyc');
    if (!contract || contract.clauses.length === 0) return null;
    return (
        <div className="flex flex-col gap-6">
            <span className="text-center fz-10 text-muted uppercase">{t('contractTitle')}</span>
            {/* The greeting heads the contract: not a clause, never answered. */}
            {contract.greeting && <p className="fz-10 whitespace-pre-line text-muted px-12">{contract.greeting}</p>}
            {contract.clauses.map((c) => (
                <div key={c.number} className="flex flex-col gap-8 rad-12 bg-surface px-12 py-8">
                    <p className="fz-10 whitespace-pre-line text-muted">{c.text}</p>
                    <div className="flex gap-16">
                        <Choice on={c.answer === 'agree'} tint="green" label={t('iAgree')} disabled />
                        <Choice on={c.answer === 'disagree'} tint="red" label={t('iDisagree')} disabled />
                    </div>
                </div>
            ))}
        </div>
    );
}

/** Their files (frame 20): both faces, the document, what was read off it, and the verifier's mark with the day. */
export function AdminFiles({ admin }: { admin: BusinessAdmin }) {
    const t = useTranslations('work.kyc');
    const login = admin.loginApproval;
    const day = dayOf(login?.decided_at ?? login?.requested_at);
    return (
        <div className="flex flex-col gap-6">
            <Faces login={login} admin={admin} size={199} />
            <IdImages login={login} />
            <KycFields login={login} birthday />
            {login && (
                <div className="flex h-36 items-center justify-between rad-12 bg-surface px-12 fz-10 text-ink">
                    <span>
                        <span className="font-bold">{t('brandStrong')}</span>
                        {t('brandLight')}
                    </span>
                    <span>{day}</span>
                </div>
            )}
            <ContractTerms contract={admin.contract} />
        </div>
    );
}

'use client';

import type { CSSProperties } from 'react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { motion, useDragControls } from 'motion/react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { iosEase } from '@/components/motion/presets';
import { cn } from '@/lib/utils/cn';
import type { AdminStage, BusinessAdmin, LogLine } from '../schema';
import { LOGIN_DURATION, stageLog } from '../stage-log';
import { DashedInput, InfoField, PanelTitle } from './parts';

/*
 * A dashboard's business admins (XD "Root Dashboard home page" 18–33): the
 * list on Login Info, each with where it stands — a coloured line that opens
 * its log — the Add Business Admin sheet, and the review of the files the
 * admin's sign-in collected.
 *
 * ⚠️ Design only. The second Root's approval and the admin's sign-in are
 * SIMULATED here (they complete on a timer), so every state the design shows
 * can be walked through. In the real flow both arrive from the backend.
 */

/** The coloured line under an admin, per stage (frames 19, 23, 24, 25, 26). */
const STAGE_STYLE: Record<Exclude<AdminStage, 'active'>, { bg: string; icon?: string }> = {
    approval: { bg: '#fdf3c4' },
    send: { bg: '#d4fbff', icon: 'work/send' },
    login: { bg: '#fdf9c4' },
    review: { bg: '#cfe6ff' },
};

/** A person's photo, or the avatar glyph while there is none. */
export function AdminPhoto({ src, size, className }: { src?: string; size: number; className?: string }) {
    const box = { width: `${size * 0.0625}rem`, height: `${size * 0.0625}rem` };
    return src ? (
        // A picked file (an object URL) — content, not an icon, so not <Icon>.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" style={box} className={cn('shrink-0 object-cover', className)} />
    ) : (
        <span style={box} className={cn('bg-surface grid shrink-0 place-items-center overflow-hidden', className)}>
            <Icon name="side/avatar" width={size} height={size} />
        </span>
    );
}

/** The admin's row: photo, short name, name — and a check once its files are in (grey) or approved (blue). */
export function AdminRow({
    admin,
    photo,
    onOpen,
}: {
    admin: BusinessAdmin;
    photo?: string;
    onOpen?: () => void;
}) {
    const done = admin.stage === 'active';
    return (
        <div className="flex gap-4">
            <AdminPhoto src={photo} size={34} className="rad-10 h-50 w-34" />
            <span className="bg-surface rad-12 fz-12 text-ink grid h-50 w-50 shrink-0 place-items-center">{admin.short}</span>
            <button
                type="button"
                onClick={onOpen}
                disabled={!onOpen}
                className="bg-surface rad-12 fz-12 text-ink flex h-50 min-w-0 flex-1 items-center justify-between gap-8 px-12 text-start disabled:cursor-default"
            >
                <span className="truncate">{admin.name}</span>
                {(admin.stage === 'review' || done) && (
                    // Grey while the files wait for review, blue once approved (XD).
                    <Icon name={done ? 'work/check-on' : 'work/check-off'} size={14} className="shrink-0" />
                )}
            </button>
        </div>
    );
}

function Log({ lines }: { lines: LogLine[] }) {
    return (
        <ul className="bg-surface rad-12 flex flex-col gap-2 px-12 py-6">
            {lines.map((l, i) => (
                <li key={i} className="flex flex-col">
                    <span className="fz-8 text-ink flex justify-between gap-8">
                        <span>• {l.text}</span>
                        {l.at && <span className="text-muted shrink-0">{l.at}</span>}
                    </span>
                    {l.sub && (
                        <ul className="flex flex-col ps-12">
                            {l.sub.map((s, j) => (
                                <li key={j} className="fz-8 text-ink">
                                    • {s.text}
                                </li>
                            ))}
                        </ul>
                    )}
                </li>
            ))}
        </ul>
    );
}

/** The coloured line under an admin and its log (⋮ opens it). `onAct` is the line's own action, where it has one. */
function StageLine({ admin, onAct, onShowFile }: { admin: BusinessAdmin; onAct?: () => void; onShowFile: () => void }) {
    const t = useTranslations('work.admins');
    const [open, setOpen] = useState(false);
    if (admin.stage === 'active') return null;
    const style = STAGE_STYLE[admin.stage];
    return (
        <div className="flex flex-col gap-4">
            <div className="rad-10 fz-10 text-ink flex h-22 items-center px-12" style={{ backgroundColor: style.bg }}>
                <button
                    type="button"
                    onClick={onAct}
                    disabled={!onAct}
                    className="flex flex-1 items-center justify-center gap-6 disabled:cursor-default"
                >
                    {style.icon && <Icon name={style.icon} size={10} mask />}
                    {t(`stage.${admin.stage}`)}
                </button>
                <button
                    type="button"
                    onClick={() => setOpen((o) => !o)}
                    aria-expanded={open}
                    aria-label={t('log')}
                    className="fz-12 shrink-0 leading-none"
                >
                    {open ? '••' : '⋮'}
                </button>
            </div>
            {admin.stage === 'review' && (
                <button
                    type="button"
                    onClick={onShowFile}
                    className="bg-surface rad-10 fz-10 text-ink h-22"
                >
                    {t('showFile')}
                </button>
            )}
            {open && (
                <>
                    <Log lines={stageLog(admin.stage)} />
                    {admin.stage !== 'approval' && admin.stage !== 'send' && (
                        <span className="fz-10 text-ink flex flex-col px-12">
                            <span>{t('duration', { full: LOGIN_DURATION.full })}</span>
                            <span className="text-muted">
                                {t('durationSplit', {
                                    user: LOGIN_DURATION.user,
                                    system: LOGIN_DURATION.system,
                                    approval: LOGIN_DURATION.approval,
                                })}
                            </span>
                        </span>
                    )}
                </>
            )}
        </div>
    );
}

/** Login Info: the dashboard's link, then its admins, each with where it stands. */
export function LoginInfo({
    link,
    admins,
    photos,
    onAdvance,
    onOpenAdmin,
    onReview,
}: {
    link: string;
    admins: BusinessAdmin[];
    photos: Record<string, string>;
    onAdvance: (id: string, to: AdminStage) => void;
    onOpenAdmin: (id: string) => void;
    onReview: (id: string) => void;
}) {
    const t = useTranslations('work.admins');

    // ⚠️ SIMULATED: the second Root approves, and the admin signs in, a few
    // seconds after the screen shows them waiting.
    useEffect(() => {
        const timers = admins.flatMap((a) =>
            a.stage === 'approval'
                ? [window.setTimeout(() => onAdvance(a.id, 'send'), 4000)]
                : a.stage === 'login'
                  ? [window.setTimeout(() => onAdvance(a.id, 'review'), 5000)]
                  : [],
        );
        return () => timers.forEach((x) => window.clearTimeout(x));
    }, [admins, onAdvance]);

    return (
        <div className="flex flex-col gap-8">
            <PanelTitle>{t('loginInfo')}</PanelTitle>
            <InfoField label={t('link')} value={<span className="text-primary">{link}</span>} />
            {admins.length > 0 && (
                <>
                    <PanelTitle>{t('list')}</PanelTitle>
                    {admins.map((a) => (
                        <div key={a.id} className="flex flex-col gap-4">
                            <AdminRow admin={a} photo={photos[a.id]} onOpen={() => onOpenAdmin(a.id)} />
                            <StageLine
                                admin={a}
                                onAct={a.stage === 'send' ? () => onAdvance(a.id, 'login') : undefined}
                                onShowFile={() => onReview(a.id)}
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
            className="rad-12 fz-12 text-ink hairline bg-surface mx-auto h-50 w-406 max-w-full shrink-0"
            style={{ '--hairline-radius': '0.75rem', '--hairline-color': '#bcd8ff' } as CSSProperties}
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
            className={cn('bg-background rad-20 flex flex-1 flex-col overflow-hidden shadow-sm', className)}
        >
            {/* The grab bar — drag only (a tap would close a sheet the person
                only nudged); the navbar's X closes it without a swipe. */}
            <div
                aria-hidden
                onPointerDown={(e) => controls.start(e)}
                className="flex h-20 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
            >
                <span className="bg-muted h-4 w-40 rounded-full opacity-60" />
            </div>
            {children}
        </motion.div>
    );
}

/* ───────────────────────────── Add ───────────────────────────── */

export type NewAdmin = Pick<BusinessAdmin, 'name' | 'phone' | 'ips' | 'mac' | 'device' | 'secretWords'> & { photo?: string };

/**
 * The Add Business Admin sheet (frames 20–21): the photo (picked from a file),
 * the name exactly as on their ID, phone, IPs, MAC address, device and secret
 * words. Adding sends it to the second Root for approval.
 */
export function AddAdminSheet({ onAdd, onClose }: { onAdd: (a: NewAdmin) => void; onClose: () => void }) {
    const t = useTranslations('work.admins');
    const [photo, setPhoto] = useState<string>();
    const [f, setF] = useState({ name: '', phone: '', ips: '', mac: '', device: '', secretWords: '' });
    const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
    const ready = !!f.name.trim() && !!f.phone.trim();

    return (
        <SwipeSheet onClose={onClose} className="gap-8 px-8 pb-12">
            <span className="fz-10 text-ink text-center">{t('sheet.title')}</span>
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto">
                <label className="rad-24 relative mx-auto block h-240 w-240 cursor-pointer overflow-hidden">
                    <AdminPhoto src={photo} size={240} className="rad-24" />
                    <span className="fz-12 absolute inset-x-0 bottom-0 flex h-32 items-center justify-center gap-6 bg-black/85 text-white">
                        <Icon name="work/photo" size={14} mask />
                        {photo ? t('sheet.editPhoto') : t('sheet.addPhoto')}
                    </span>
                    <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) setPhoto(URL.createObjectURL(file));
                        }}
                    />
                </label>
                <DashedInput label={t('sheet.name')} value={f.name} onChange={set('name')} />
                <DashedInput label={t('sheet.phone')} value={f.phone} onChange={set('phone')} />
                <DashedInput label={t('sheet.ips')} value={f.ips} onChange={set('ips')} />
                <DashedInput label={t('sheet.mac')} value={f.mac} onChange={set('mac')} />
                <DashedInput label={t('sheet.device')} value={f.device} onChange={set('device')} />
                <DashedInput label={t('sheet.secret')} value={f.secretWords} onChange={set('secretWords')} />
            </div>
            {ready && (
                <button
                    type="button"
                    onClick={() => onAdd({ ...f, photo })}
                    // 406 × 50, #3066cc, radius 12 (XD).
                    className="bg-primary rad-12 fz-12 mx-auto flex h-50 w-406 max-w-full shrink-0 items-center justify-center gap-6 text-white"
                >
                    ↳ {t('add')}
                </button>
            )}
        </SwipeSheet>
    );
}

/* ──────────────────────────── Review ──────────────────────────── */

/** The ID document's two sides — placeholders until the sign-in sends real images. */
function IdImages() {
    return (
        <div className="flex gap-6">
            {[0, 1].map((i) => (
                <span key={i} className="bg-surface rad-12 grid h-76 flex-1 place-items-center">
                    <Icon name="work/id-card" size={26} />
                </span>
            ))}
        </div>
    );
}

/** What the admin's ID says (frames 27, 37). */
export function KycFields({ admin, birthday }: { admin: BusinessAdmin; birthday?: boolean }) {
    const t = useTranslations('work.kyc');
    const k = admin.kyc;
    if (!k) return null;
    return (
        <div className="flex flex-col gap-4">
            <InfoField label={t('idType')} value={k.idType} />
            <InfoField label={t('country')} value={k.country} />
            <InfoField label={t('name')} value={k.name} />
            <InfoField label={t('nationalNumber')} value={k.nationalNumber} />
            {birthday && <InfoField label={t('birthday')} value={k.birthday} />}
        </div>
    );
}

/** Reviewing the files an admin's sign-in collected, then approving them (frame 27). */
export function ReviewSheet({
    admin,
    photo,
    onApprove,
    onClose,
}: {
    admin: BusinessAdmin;
    photo?: string;
    onApprove: () => void;
    onClose: () => void;
}) {
    const t = useTranslations('work.kyc');
    return (
        <SwipeSheet onClose={onClose} className="gap-8 px-8 pb-8">
            <AdminRow admin={admin} photo={photo} />
            <div className="thin-scroll flex flex-1 flex-col gap-6 overflow-y-auto">
                <AdminPhoto src={photo} size={240} className="rad-24 mx-auto" />
                <IdImages />
                <KycFields admin={admin} />
            </div>
            <button
                type="button"
                onClick={onApprove}
                className="rad-12 fz-12 text-primary h-36 shrink-0"
                style={{ outline: '0.0625rem dashed #bcd8ff', outlineOffset: '-0.0625rem' }}
            >
                {t('approve')}
            </button>
        </SwipeSheet>
    );
}

/** The admin's own files, as their sign-in captured them (frame 37). */
export function AdminFiles({ admin, photo }: { admin: BusinessAdmin; photo?: string }) {
    const t = useTranslations('work.kyc');
    return (
        <div className="flex flex-col gap-6">
            <div className="flex gap-6">
                {(['entered', 'detected'] as const).map((k) => (
                    <div key={k} className="flex flex-1 flex-col items-center gap-4">
                        <AdminPhoto src={photo} size={136} className="rad-20" />
                        <span className="fz-10 text-ink">{t(k)}</span>
                    </div>
                ))}
            </div>
            <IdImages />
            <KycFields admin={admin} birthday />
        </div>
    );
}

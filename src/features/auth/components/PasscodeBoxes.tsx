'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';

/**
 * Segmented code entry for OTP / passcode screens. A single hidden input
 * captures digits; the boxes are display-only and navigate to `nextHref` on
 * completion. Each box is 60×60, radius 15, 0.5px border.
 *
 * variant "otp" (verification / set passcode):
 *   empty → white bg + #388CFF dashed; filled → #FCFCFC bg + #C3C3C3 dashed.
 * variant "passcode" (enter passcode):
 *   empty → white bg + #C3C3C3 dashed; focused box → #388CFF dashed;
 *   filled → #FCFCFC bg + #4D84FF solid.
 *
 *   - mask: filled boxes show the lock glyph instead of the digit (passcodes).
 */
type Props = {
    length?: number;
    /** Navigate here on completion (used when there's no onComplete handler). */
    nextHref?: string;
    /** Called with the full value on completion (overrides nextHref navigation). */
    onComplete?: (value: string) => void;
    variant?: 'otp' | 'passcode';
    mask?: boolean;
    /** Show all filled boxes with a green (matched) border. */
    success?: boolean;
};

export function PasscodeBoxes({
    length = 6,
    nextHref,
    onComplete,
    variant = 'otp',
    mask = false,
    success = false,
}: Props) {
    const [value, setValue] = useState('');
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    // Completion must fire exactly ONCE per fill. Extra keystrokes while the
    // handler is in flight used to re-trigger onComplete with the same value —
    // duplicate requests that burned the backend's 5/min throttle. The parent
    // clears the boxes by remounting (key bump), which resets this too.
    const completedRef = useRef(false);
    const router = useRouter();

    useEffect(() => {
        inputRef.current?.focus({ preventScroll: true });
    }, []);

    function onChange(e: React.ChangeEvent<HTMLInputElement>) {
        if (completedRef.current) return;
        const next = e.target.value.replace(/\D/g, '').slice(0, length);
        setValue(next);
        if (next.length === length) {
            completedRef.current = true;
            if (onComplete) onComplete(next);
            else if (nextHref) router.push(nextHref);
        }
    }

    return (
        <div
            className="relative"
            onMouseDown={(e) => {
                e.preventDefault();
                inputRef.current?.focus();
            }}
        >
            <div className="flex gap-6">
                {Array.from({ length }).map((_, i) => {
                    const filled = i < value.length;
                    const isActive = focused && i === value.length;

                    let stroke: string;
                    let fill: string;
                    let dashed: boolean;
                    if (success && filled) {
                        stroke = '#34C759';
                        fill = '#FCFCFC';
                        dashed = false;
                    } else if (variant === 'passcode') {
                        if (filled) {
                            stroke = '#4D84FF';
                            fill = '#FCFCFC';
                            dashed = false;
                        } else if (isActive) {
                            stroke = '#388CFF';
                            fill = '#FFFFFF';
                            dashed = true;
                        } else {
                            stroke = '#C3C3C3';
                            fill = '#FFFFFF';
                            dashed = true;
                        }
                    } else if (filled) {
                        stroke = '#C3C3C3';
                        fill = '#FCFCFC';
                        dashed = true;
                    } else {
                        stroke = '#388CFF';
                        fill = '#FFFFFF';
                        dashed = true;
                    }

                    return (
                        <div key={i} className="relative h-60 w-60">
                            <svg
                                aria-hidden
                                className="absolute inset-0 h-full w-full"
                                viewBox="0 0 60 60"
                                preserveAspectRatio="none"
                            >
                                <rect
                                    x="0.25"
                                    y="0.25"
                                    width="59.5"
                                    height="59.5"
                                    rx="14.75"
                                    fill={fill}
                                    stroke={stroke}
                                    strokeWidth="0.5"
                                    strokeDasharray={dashed ? '3 3' : undefined}
                                />
                            </svg>
                            <div className="fz-24 text-ink relative flex h-full w-full items-center justify-center font-medium">
                                {filled && mask ? (
                                    <Icon
                                        name="auth/pin_lock"
                                        width={16}
                                        height={24}
                                        mask
                                        className="text-[#388CFF]"
                                    />
                                ) : filled ? (
                                    value[i]
                                ) : null}
                            </div>
                        </div>
                    );
                })}
            </div>

            <input
                ref={inputRef}
                value={value}
                onChange={onChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Code"
                className="absolute inset-0 h-full w-full cursor-default opacity-0 outline-none"
            />
        </div>
    );
}

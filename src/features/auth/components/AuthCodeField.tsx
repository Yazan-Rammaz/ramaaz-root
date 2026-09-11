"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";

/**
 * The one auth entry field (private code, password, …). Native caret hidden; a
 * blinking underscore is overlaid at the insertion point (absolute, never shifts
 * the placeholder). Dashed 0.5px SVG outline: grey at rest, #388CFF while the
 * user is typing. Once the value reaches `revealArrowAt`, a 20×20 arrow appears
 * (20 from the end); clicking it — or pressing Enter — navigates to `nextHref`.
 *
 * XD: 390 x 60, radius 20, dashed 0.5 / dash 3, placeholder #C3C3C3 16/20,
 * value #1D1D1D.
 */
type Props = {
  placeholder: string;
  ariaLabel: string;
  /** Min length before the submit arrow appears / submit is allowed. */
  revealArrowAt: number;
  /** Where the arrow (and Enter) navigates (when there's no onSubmit). */
  nextHref?: string;
  /** Called with the value on submit — overrides nextHref navigation. */
  onSubmit?: (value: string) => void | Promise<void>;
  /**
   * Every keystroke. Exists so the caller can retire a stale error the moment
   * the user starts a new attempt — a message about the code they just typed
   * is wrong the instant they begin changing it, and leaving it up until the
   * next submit means they retype the whole code under a red line accusing
   * them of something they are already fixing.
   *
   * Deliberately not `onChange`: this hands over the VALUE, not the event, and
   * the field keeps owning its own state.
   */
  onValueChange?: (value: string) => void;
  maxLength?: number;
  /** Mask the typed value (password step). */
  secret?: boolean;
  /**
   * Starting value. Used by the temporary dev autofill; since it arrives
   * asynchronously, the caller remounts this component with a `key` so the
   * value lands as initial state instead of via a state-setting effect.
   */
  defaultValue?: string;
};

export function AuthCodeField({
  placeholder,
  ariaLabel,
  revealArrowAt,
  nextHref,
  onSubmit,
  onValueChange,
  maxLength,
  secret = false,
  defaultValue = "",
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Focus on mount without scrolling the page (avoids a load-time jump).
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const typing = value.length > 0;
  const canSubmit = value.length >= revealArrowAt && !busy;

  async function submit() {
    if (!canSubmit) return;
    if (onSubmit) {
      setBusy(true);
      try {
        await onSubmit(value);
      } finally {
        setBusy(false);
      }
    } else if (nextHref) {
      router.push(nextHref);
    }
  }

  return (
    <div className="relative h-60 w-390">
      {/* Dashed rounded outline (even dashes via SVG stroke). */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 390 60"
        preserveAspectRatio="none"
      >
        <rect
          x="0.25"
          y="0.25"
          width="389.5"
          height="59.5"
          rx="19.75"
          fill="none"
          stroke={typing ? "#388CFF" : "#5D5C5D"}
          strokeWidth="0.5"
          strokeDasharray="3 3"
        />
      </svg>

      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onValueChange?.(e.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        type={secret ? "password" : "text"}
        autoComplete="off"
        maxLength={maxLength}
        className={`caret-transparent fz-16 text-ink placeholder:text-muted absolute inset-0 h-full w-full bg-transparent ps-24 font-normal outline-none ${canSubmit ? "pe-56" : "pe-24"}`}
      />

      {/* Blinking underscore caret, overlaid at the end of the typed value. */}
      {focused && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center px-24"
        >
          <span className="fz-16 invisible font-normal whitespace-pre">
            {secret ? "•".repeat(value.length) : value}
          </span>
          <span className="caret-blink fz-16 text-ink font-normal">_</span>
        </div>
      )}

      {/* Submit arrow — appears once the value is long enough. */}
      {canSubmit && (
        <button
          type="button"
          onClick={submit}
          aria-label="Continue"
          className="absolute end-20 top-1/2 flex -translate-y-1/2 items-center justify-center"
        >
          <Icon
            name="auth/phonenumber_arrow"
            size={20}
            mask
            className="text-[#388CFF] rtl:-scale-x-100"
          />
        </button>
      )}
    </div>
  );
}

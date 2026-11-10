"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { cardOpen, iosEase } from "@/components/motion/presets";
import { DashedFrame } from "@/components/ui/DashedFrame";
import { FormError } from "@/components/ui/FormError";
import { useLockWhenLocked } from "@/features/auth/use-lock-when-locked";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import {
  connectProjectAction,
  createProjectAction,
  type ProjectFormState,
} from "../actions";
import { CONNECTION_ERRORS, type System } from "../schema";

/**
 * The add-project drawer — two steps, because the project team has to install
 * the root verifier between them (console-api.md §5.2–5.3):
 *
 *   create   code, full name, Arabic name, description → the project, DRAFT
 *   connect  its base URL → the handshake → CONNECTED, or FAILED with a reason
 *
 * No XD frame exists for it yet, so it borrows the regions add drawer's shell
 * (430 wide, dashed frame, action pinned to the bottom) and fields. No inner
 * close control: the navbar "+" is an X while it's open.
 *
 * Connect answers 200 even when the handshake fails, so a FAILED project is not
 * an error state here: it's the result, shown with the URL still filled in so
 * Connect can simply be pressed again.
 */
export function AddProjectDrawer({
  step,
  project,
  savedBaseUrl,
  onCreated,
}: {
  step: "create" | "connect" | null;
  project?: System;
  /** Pre-fills the connect step: the URL the last connect saved. */
  savedBaseUrl?: string;
  onCreated: (project: System) => void;
}) {
  const reduce = useReducedMotion();

  return (
    <AnimatePresence mode="wait">
      {step && (
        <motion.aside
          key={step === "connect" ? `connect-${project?.id}` : "create"}
          variants={cardOpen}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={reduce ? { duration: 0 } : iosEase}
          className="bg-background relative flex h-full w-430 max-w-full shrink-0 flex-col"
        >
          <DashedFrame radius={20} color="#8d8d8d" />
          {step === "create" ? (
            <CreateStep onCreated={onCreated} />
          ) : (
            project && <ConnectStep project={project} savedBaseUrl={savedBaseUrl} />
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/* ───────────────────────────── step 1: create ───────────────────────────── */

const EMPTY_DRAFT = { code: "", name: "", name_ar: "", description: "" };

/**
 * What was typed into the create step, for this browser tab — so a refused
 * create, or closing and reopening the drawer, finds every field as it was left.
 * Cleared once the project is created. Memory only, like `typedBaseUrl`.
 */
let createDraft = EMPTY_DRAFT;

function CreateStep({ onCreated }: { onCreated: (project: System) => void }) {
  const t = useTranslations("system.form");
  const [values, setValues] = useState(() => createDraft);
  const [state, action, pending] = useActionState(
    async (prev: ProjectFormState, form: FormData) => {
      const next = await createProjectAction(prev, form);
      if (next.project) {
        createDraft = EMPTY_DRAFT;
        onCreated(next.project);
      }
      return next;
    },
    {},
  );
  // The session wanted the PIN: lock; the fields stay as typed for the retry.
  useLockWhenLocked(state);
  const set = (field: keyof typeof values) => (v: string) =>
    setValues((s) => (createDraft = { ...s, [field]: v }));

  return (
    <form action={action} className="flex min-h-0 flex-1 flex-col">
      <div className="thin-scroll flex flex-1 flex-col gap-16 overflow-y-auto px-12 py-24">
        <Title icon="nav/add">{t("createTitle")}</Title>
        <StepDots current={1} />

        <Field
          name="code"
          label={t("code")}
          hint={t("codeHint")}
          value={values.code}
          maxLength={20}
          // Codes are lowercase by rule; typing "RDB" should just work.
          onChange={(v) => set("code")(v.toLowerCase())}
          error={state.fields?.code}
        />
        <Field
          name="name"
          label={t("name")}
          value={values.name}
          maxLength={100}
          onChange={set("name")}
          error={state.fields?.name}
        />
        <Field
          name="name_ar"
          label={t("nameAr")}
          hint={t("optional")}
          value={values.name_ar}
          maxLength={100}
          onChange={set("name_ar")}
          error={state.fields?.name_ar}
        />
        <Field
          name="description"
          label={t("description")}
          hint={t("descriptionHint")}
          value={values.description}
          maxLength={150}
          onChange={set("description")}
          error={state.fields?.description}
        />

        <p className="fz-12 text-muted font-light">{t("codeForever")}</p>
        <FormError message={state.error} attempt={state} />
      </div>

      <Footer>
        <Primary type="submit" disabled={pending}>
          {pending ? t("creating") : t("create")}
        </Primary>
      </Footer>
    </form>
  );
}

/* ───────────────────────────── step 2: connect ───────────────────────────── */

/**
 * The last URL typed per project, for this browser tab. The backend's saved URL
 * covers a closed-and-reopened step (even after a reload); this covers the one
 * it never saved (a URL its rules refused), so reopening still shows what was
 * typed last. Memory only: it's a convenience, never a source of truth.
 */
const typedBaseUrl = new Map<string, string>();

function ConnectStep({
  project: initial,
  savedBaseUrl,
}: {
  project: System;
  savedBaseUrl?: string;
}) {
  const t = useTranslations("system.connection");
  const [baseUrl, setBaseUrl] = useState(
    () => typedBaseUrl.get(initial.id) ?? savedBaseUrl ?? "",
  );
  const [state, action, pending] = useActionState(
    connectProjectAction.bind(null, initial.id),
    {},
  );
  useLockWhenLocked(state);

  // The connect's answer, or the list's own data before the first one.
  const project = state.project ?? initial;
  const connected = project.connectionStatus === "CONNECTED";

  // Errors belong to the attempt that produced them. So a step opened on a
  // project that failed last time starts clean (only `state` from a connect in
  // THIS drawer counts, never the list's data), and editing the URL clears the
  // message: `dismissed` remembers which answer was dismissed, and the next
  // connect produces a new one, which shows again.
  const [dismissed, setDismissed] = useState<ProjectFormState | null>(null);
  const live = dismissed === state ? {} : state;
  const failure = live.project?.connectionStatus === "FAILED" ? live.project.connectionError : undefined;
  // Our sentence says what KIND of failure it was; the backend's message says
  // which part — for PROJECT_BAD_MANIFEST it names the field (console-api.md
  // §5.3). Both are shown: the sentence alone left nothing to send the
  // project team.
  const failureText = failure
    ? isKnownError(failure.code)
      ? [t(`errors.${failure.code}`), failure.message].filter(Boolean).join(" · ")
      : (failure.message ?? t("failed"))
    : undefined;

  return (
    <form action={action} className="flex min-h-0 flex-1 flex-col">
      <div className="thin-scroll flex flex-1 flex-col gap-16 overflow-y-auto px-12 py-24">
        <Title icon="nav/rocket">{t("title")}</Title>
        <StepDots current={2} />

        {/* The project being connected — the same three lines as its card. */}
        <div className="bg-surface rad-12 flex flex-col px-12 py-12">
          <span className="fz-16 text-ink font-medium">{project.code}</span>
          <span className="fz-14 text-ink">{project.name}</span>
          <span className="fz-12 text-ink font-light">{project.description}</span>
        </div>

        {!connected && (
          <>
            <p className="fz-12 text-ink font-light leading-normal">
              {t.rich("instructions", {
                code: project.code,
                b: (chunks) => <span className="font-semibold">{chunks}</span>,
              })}
            </p>
            <Field
              name="base_url"
              label={t("baseUrl")}
              hint="https://api.example.com"
              value={baseUrl}
              type="url"
              onChange={(v) => {
                setBaseUrl(v);
                typedBaseUrl.set(initial.id, v);
                setDismissed(state);
              }}
              error={live.fields?.base_url}
            />
          </>
        )}

        {connected && <Outcome title={t("connected")} />}

        {/* Why the last connect failed, or why it couldn't be sent: one red
            line, no box (FormError). */}
        <FormError message={failureText ?? live.error} attempt={state} />
      </div>

      <Footer>
        {connected ? (
          <Link
            href="/systems"
            className="bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center font-medium text-white"
          >
            {t("done")}
          </Link>
        ) : (
          // One button: after a failure the URL is still there, and connecting
          // again re-runs the handshake — no separate "test".
          <Primary type="submit" disabled={pending}>
            {pending ? t("connecting") : t("connect")}
          </Primary>
        )}
      </Footer>
    </form>
  );
}

function isKnownError(
  code: string | undefined,
): code is (typeof CONNECTION_ERRORS)[number] {
  return (CONNECTION_ERRORS as readonly string[]).includes(code ?? "");
}

/* ───────────────────────────── pieces ───────────────────────────── */

function Title({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="fz-16 text-ink flex items-center gap-8 font-medium">
      <Icon name={icon} size={18} mask />
      {children}
    </span>
  );
}

/** "1 — 2": where in the two steps this is. */
function StepDots({ current }: { current: 1 | 2 }) {
  const t = useTranslations("system.form");
  return (
    <div className="flex items-center gap-8">
      {([1, 2] as const).map((n) => (
        <span
          key={n}
          className={cn(
            "fz-12 rad-12 flex h-26 items-center px-12",
            n === current ? "bg-ink text-white" : "bg-surface text-muted",
          )}
        >
          {t(n === 1 ? "stepCreate" : "stepConnect")}
        </span>
      ))}
    </div>
  );
}

/** The regions drawer's field: a surface box, a small label, the input. */
function Field({
  name,
  label,
  hint,
  value,
  onChange,
  maxLength,
  type = "text",
  error,
}: {
  name: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  type?: "text" | "url";
  error?: string;
}) {
  const id = `project-${name}`;
  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor={id}
        className={cn(
          "bg-surface rad-12 flex h-54 flex-col justify-center px-12",
          error && "hairline",
        )}
        style={
          error
            ? ({ "--hairline-radius": "0.75rem", "--hairline-color": "#ef4444" } as React.CSSProperties)
            : undefined
        }
      >
        <span className="fz-10 text-muted">{label}</span>
        <input
          id={id}
          name={name}
          type={type}
          value={value}
          maxLength={maxLength}
          placeholder={hint}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="fz-14 text-ink placeholder:fz-12 placeholder:text-muted w-full min-w-0 bg-transparent outline-none"
        />
      </label>
      {error && (
        <p id={`${id}-error`} className="fz-12 text-red-500 ps-12">
          {error}
        </p>
      )}
    </div>
  );
}

/** A successful connect. */
function Outcome({ title }: { title: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={iosEase}
      role="status"
      className="rad-12 fz-14 flex bg-green-50 px-12 py-12 font-medium text-green-700"
    >
      {title}
    </motion.div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="shrink-0 p-24 pt-0">{children}</div>;
}

function Primary({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "bg-primary fz-14 rad-12 flex h-50 w-full items-center justify-center font-medium text-white disabled:opacity-50",
        className,
      )}
    />
  );
}

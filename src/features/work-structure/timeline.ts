import type { LogLine, NameMap, Timeline } from "./schema";

/*
 * The onboarding timeline (console-api.md §5.16) as the log lines the panel
 * shows, and the formatting of its durations. Nothing is computed here: every
 * time and every wait is the backend's.
 */

/** "850 ms", "12.4 s", "3 min", "2 h 5 min". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** The words for each event — the caller's translator, so this stays free of i18n plumbing. */
export type EventLabel = (kind: string, values: { purpose?: string; stage?: string; detail?: string }) => string;

export function timelineLines(timeline: Timeline, label: EventLabel): LogLine[] {
  return timeline.events.map((e) => ({
    text: label(e.kind, { purpose: e.purpose, stage: e.stage, detail: e.detail }),
    at: clock(e.at),
    wait: e.duration_ms ? formatDuration(e.duration_ms) : undefined,
    waitingOn: e.waiting_on,
    failed: e.kind === "MESSAGE_FAILED",
    detail: e.kind === "MESSAGE_FAILED" ? e.detail : undefined,
  }));
}

/**
 * Did the latest Get Started message fail (`MESSAGE_FAILED`,
 * 2026-11-18-message-failed-timeline.md)? Then nothing reached the person, and
 * the step is Root's again: send it once more.
 */
export function getStartedFailed(timeline: Timeline | undefined): boolean {
  const messages = (timeline?.events ?? []).filter((e) => e.purpose === "GET_STARTED" && e.kind.startsWith("MESSAGE_"));
  return messages.at(-1)?.kind === "MESSAGE_FAILED";
}

/** A name in the screen's language, else English, else any. */
export function pickName(name: NameMap | undefined, locale: string): string {
  if (!name) return "";
  return name[locale] ?? name.en ?? Object.values(name)[0] ?? "";
}

import type { LocalizedName } from "@/lib/i18n/localized";
import type { LanguageStatus } from "./schema";

/*
 * Names in every language the project lists — the rules every name form
 * follows (`2026-11-08-languages-screen-and-names.md` §1–§2). Client-safe: the
 * forms import these, the Server Actions check the result again.
 *
 * A form holds a name as ROWS, one per language, keyed by the language's code
 * upper-cased (`EN`, `CKB`, `ZH-HANT`) — the chip the row shows, and what the
 * AI pass answers with. `codeOf` turns a row back into RDB's own code.
 */

/** A project language as a name form needs it (built from `language.list` on the server). */
export type NameLanguage = {
  /** RDB's code, canonical casing (`zh-Hant`) — the key in a name. */
  code: string;
  /** The row's chip and key in the form: the code upper-cased. */
  chip: string;
  /** The row's label: the language's name in itself. */
  label: string;
  direction: "ltr" | "rtl";
  status: LanguageStatus;
  /** `en` and `ar`: the row must be filled. */
  required: boolean;
};

export type NameRow = { code: string; name: string };

export const chipOf = (code: string) => code.toUpperCase();

/** RDB's code for a row's chip. */
export function codeOf(languages: NameLanguage[], chip: string): string {
  return languages.find((l) => l.chip === chip)?.code ?? chip.toLowerCase();
}

/**
 * The languages a name gets a row for: every one names can use (not
 * `INACTIVE`), plus an `INACTIVE` one the stored name still has text in —
 * shown read-only, with Remove.
 */
export function rowLanguages(languages: NameLanguage[], stored?: LocalizedName): NameLanguage[] {
  return languages.filter((l) => l.status !== "INACTIVE" || !!stored?.[l.code]?.trim());
}

/** A name's rows, from what is stored. `typedEn` fills an empty English row. */
export function nameRows(languages: NameLanguage[], stored?: LocalizedName, typedEn = ""): NameRow[] {
  return rowLanguages(languages, stored).map((l) => ({
    code: l.chip,
    name: stored?.[l.code] ?? (l.code === "en" ? typedEn : ""),
  }));
}

const text = (rows: NameRow[], chip: string) => rows.find((r) => r.code === chip)?.name.trim() ?? "";

/** A required language (`en`, `ar`) with no text — the form blocks saving. */
export function missingRequired(languages: NameLanguage[], rows: NameRow[]): boolean {
  return languages.some((l) => l.required && !text(rows, l.chip));
}

/** Every required language (`en`, `ar`) has text in a name about to be created. */
export function requiredFilled(languages: NameLanguage[], name: Record<string, string>): boolean {
  return languages.every((l) => !l.required || !!name[l.code]);
}

/**
 * The `name` a create sends: every filled row of a language names can use.
 * An empty row is left out — never `""`.
 */
export function nameForCreate(languages: NameLanguage[], rows: NameRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of languages) {
    const v = text(rows, l.chip);
    if (v && l.status !== "INACTIVE") out[l.code] = v;
  }
  return out;
}

/**
 * The `name` an update sends: only the languages whose text changed — an
 * emptied row is `null` (removed in RDB). Undefined when nothing changed, so
 * the field is left out of the body. A row for a language the project no
 * longer lists is ignored.
 */
export function nameChanges(
  languages: NameLanguage[],
  stored: LocalizedName | undefined,
  rows: NameRow[],
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const r of rows) {
    const code = codeOf(languages, r.code);
    if (!languages.some((l) => l.code === code)) continue;
    const before = stored?.[code]?.trim() ?? "";
    const after = r.name.trim();
    if (after !== before) out[code] = after || null;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The stored name once a create or update went through. */
export function applyName(
  stored: LocalizedName | undefined,
  change: Record<string, string | null> | undefined,
): LocalizedName {
  const next: LocalizedName = { ...stored };
  for (const [code, v] of Object.entries(change ?? {})) {
    if (v) next[code] = v;
    else delete next[code];
  }
  return next;
}

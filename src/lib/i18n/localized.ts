import { z } from "zod";

/**
 * A project's own name for something — an open map keyed by language code
 * (`{ en, ar, tr, ckb, … }`) on every RDB object that has one: a currency, a
 * country, a region, a region type (`2026-11-08-languages-screen-and-names.md`
 * §2). `en` and `ar` are required when RDB creates one; every other language
 * the project lists may be there too. Parsed leniently: a missing or `null`
 * text is simply left out, so a row with a gap still renders.
 */
export type LocalizedName = Partial<Record<string, string>>;

export const localizedNameSchema = z
  .record(z.string(), z.string().nullable())
  .transform(
    (name): LocalizedName =>
      Object.fromEntries(Object.entries(name).filter((e): e is [string, string] => !!e[1]?.trim())),
  );

/**
 * The name to show in `locale`: that language's text when the project has it
 * (Turkish now has its own), else English, else Arabic — Arabic first for an
 * Arabic interface — else whatever text there is.
 */
export function pickName(name: LocalizedName, locale: string): string {
  const own = name[locale]?.trim();
  if (own) return own;
  const ar = name.ar?.trim() ?? "";
  const en = name.en?.trim() ?? "";
  const either = locale === "ar" ? ar || en : en || ar;
  return either || Object.values(name).find((v) => v?.trim())?.trim() || "";
}

"use server";

import { z } from "zod";
import { listLanguages } from "@/features/language/api";
import { chipOf } from "@/features/language/names";
import { generateJson } from "@/lib/ai/openai";
import type { CountryDraft, SubLevelDraft, Translation } from "./mock-ai";
import { isIsoCountryCode } from "./flag-codes";
import { titleCase } from "./names";

/*
 * The AI pass behind the region drawers' "generate" animation — it fills in
 * what an administrator would otherwise look up: the name in every system
 * language written properly, and for a country its ISO code, dial code, main
 * language, currency and time zone; for a region inside one, its short name,
 * code, dial code, post code and time zone.
 *
 * The languages are the project's own (`language.list`), every one names can
 * use — `DRAFT` included, so a language can be translated before it goes live;
 * never `INACTIVE` (2026-11-08 §1). Read here rather than sent by the browser,
 * so the AI is always asked for exactly those.
 *
 * Never fails: with no key, or any AI failure, every field comes back EMPTY
 * (English = what was typed) and the drawer shows them as inputs to fill by
 * hand. Whatever the AI says is a suggestion — every field stays editable, and
 * only what the person saves reaches RDB, which keeps every language it lists.
 */

async function systemLanguages() {
  return (await listLanguages())
    .filter((l) => l.status !== "INACTIVE")
    .map((l) => ({
      code: chipOf(l.code),
      // "Kurdish (Kurmanji) — Kurmancî, ltr": the name in English says which
      // Kurdish, the native name and direction which script.
      label: `${l.name.en ?? l.nativeName} — ${l.nativeName}, ${l.direction}`,
    }));
}

const translationsJson = {
  type: "array",
  items: {
    type: "object",
    properties: { code: { type: "string" }, name: { type: "string" } },
    required: ["code", "name"],
    additionalProperties: false,
  },
};
const translationsZod = z.array(z.object({ code: z.string(), name: z.string() }));

/**
 * One row per system language, in their order; missing → empty. English is
 * the AI's properly written name, else what was typed with capitals fixed.
 */
function alignTranslations(
  languages: { code: string }[],
  answer: Translation[] | undefined,
  typed: string,
): Translation[] {
  return languages.map(({ code }) => {
    const found = answer?.find((t) => t.code.toUpperCase() === code)?.name.trim();
    return { code, name: found || (code === "EN" ? titleCase(typed) : "") };
  });
}

/**
 * A UTC offset in the one form the sheets show — `+3`, `-5`, `+5:30` —
 * whatever the model wrote (`+03:00`, `UTC+3`, `GMT +3`). Anything that is
 * not an offset comes back empty, for the person to fill in.
 */
function utcOffset(raw: string | undefined) {
  const m = raw?.replace(/\s/g, "").match(/^(?:UTC|GMT)?([+\-−])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return "";
  const sign = m[1] === "+" ? "+" : "-";
  const minutes = m[3] && m[3] !== "00" ? `:${m[3]}` : "";
  return `${sign}${Number(m[2])}${minutes}`;
}

const englishOf = (translations: Translation[]) =>
  translations.find((t) => t.code === "EN")?.name ?? "";

/**
 * The country code comes from the country's NAME: the AI's ISO code for it
 * (Qatar → `QA`), whatever short name was typed. The typed one is only the
 * fallback when the AI names no real code (no key, or not a real country).
 */
function pickCountryCode(typed: string, ai: string): string {
  const a = ai.trim().toUpperCase();
  return a && isIsoCountryCode(a) ? a : typed.trim().toUpperCase();
}

const SYSTEM =
  "You fill in reference data for an administrator's geography console. " +
  "Answer only with facts you are sure of; use an empty string for anything you are not sure of. " +
  "Names are the standard, commonly used name in each language, without explanations. " +
  "The English name is written properly — correct spelling and capital letters — even when typed in lower case or misspelled.";

const countryZod = z.object({
  translations: translationsZod,
  isoCode: z.string(),
  dialCode: z.string(),
  mainLanguage: z.object({ code: z.string(), name: z.string() }),
  currency: z.object({ code: z.string(), name: z.string() }),
  gmt: z.string(),
  hasPostCode: z.boolean(),
});

const coded = {
  type: "object",
  properties: { code: { type: "string" }, name: { type: "string" } },
  required: ["code", "name"],
  additionalProperties: false,
};

/** The Add-Country sheet for what was typed. Empty fields where the AI can't help. */
export async function generateCountryDraftAction(
  shortName: string,
  name: string,
): Promise<CountryDraft> {
  const languages = await systemLanguages();
  const answer = name.trim()
    ? await generateJson({
        name: "country_draft",
        schema: countryZod,
        jsonSchema: {
          type: "object",
          properties: {
            translations: translationsJson,
            isoCode: { type: "string", description: "ISO 3166-1 alpha-2, upper case" },
            dialCode: { type: "string", description: "International dialling code, e.g. +963" },
            mainLanguage: { ...coded, description: "Main official language: ISO 639-1 code (upper case) and English name" },
            currency: { ...coded, description: "Official currency: ISO 4217 code and English name" },
            gmt: { type: "string", description: "Main UTC offset, e.g. +3 or -5" },
            hasPostCode: { type: "boolean", description: "Whether the country uses postal codes" },
          },
          required: ["translations", "isoCode", "dialCode", "mainLanguage", "currency", "gmt", "hasPostCode"],
          additionalProperties: false,
        },
        system: SYSTEM,
        prompt:
          // The name alone identifies it: a typed short name could be wrong
          // (`QT` for Qatar) and must not steer the answer.
          `A country typed by an administrator: "${name.trim()}". ` +
          `Give its name in each of these languages (code: language): ${languages.map((l) => `${l.code}: ${l.label}`).join("; ")}. ` +
          "If this is not a real country, return empty strings everywhere.",
      })
    : null;

  const translations = alignTranslations(languages, answer?.translations, name);
  return {
    // The ISO code for the name — flags, maps and RDB all key on it.
    shortName: pickCountryCode(shortName, answer?.isoCode ?? ""),
    name: englishOf(translations),
    translations,
    mainLanguage: answer?.mainLanguage ?? { code: "", name: "" },
    currency: answer?.currency ?? { code: "", name: "" },
    phoneCode: answer?.dialCode ?? "",
    // A yes/no always has a value; only trust it when the AI knew the country.
    postCode: answer?.isoCode ? (answer.hasPostCode ? "Yes" : "No") : "",
    gmt: utcOffset(answer?.gmt),
    levels: [],
  };
}

/**
 * A name in every system language. `what` says what it names, so the AI picks
 * the right sense — "a province of Syria", "a type of administrative division".
 */
export async function translateNameAction(name: string, what: string): Promise<Translation[]> {
  const languages = await systemLanguages();
  const answer = name.trim()
    ? await generateJson({
        name: "name_translations",
        schema: z.object({ translations: translationsZod }),
        jsonSchema: {
          type: "object",
          properties: { translations: translationsJson },
          required: ["translations"],
          additionalProperties: false,
        },
        system: SYSTEM,
        prompt:
          `"${name.trim()}" is ${what}. ` +
          `Give its name in each of these languages (code: language): ${languages.map((l) => `${l.code}: ${l.label}`).join("; ")}.`,
      })
    : null;

  return alignTranslations(languages, answer?.translations, name.trim());
}

const subLevelZod = z.object({
  translations: translationsZod,
  shortName: z.string(),
  plate: z.string(),
  dialCode: z.string(),
  postCode: z.string(),
  gmt: z.string(),
});

/**
 * The Add-{Level} sheet for a region inside a country (province, district, …):
 * the same pass as a country's, sized to a region. `what` places it — "a
 * province in Syria", "a district in Damascus, Syria". Where the AI has no
 * answer of its own, the dial code and time zone are the country's
 * (`inherited`); everything else stays empty for the person to fill in.
 */
export async function generateSubLevelDraftAction(
  name: string,
  what: string,
  inherited: { phoneCode: string; gmt: string },
): Promise<SubLevelDraft> {
  const languages = await systemLanguages();
  const answer = name.trim()
    ? await generateJson({
        name: "sub_level_draft",
        schema: subLevelZod,
        jsonSchema: {
          type: "object",
          properties: {
            translations: translationsJson,
            shortName: {
              type: "string",
              description:
                "For a first-level division, the part of its ISO 3166-2 code after the hyphen (DI for Damascus, 34 for Istanbul); " +
                "otherwise a common abbreviation of at most 4 letters, upper case. Empty if there is none.",
            },
            plate: {
              type: "string",
              description:
                "The official number commonly used for it, e.g. a Turkish province's licence-plate code (34 for Istanbul). Empty if there is none.",
            },
            dialCode: {
              type: "string",
              description: "Dialling code: the country code, plus its own area code if it has one, e.g. +90 212",
            },
            postCode: { type: "string", description: "Its postal code, or the postal-code prefix shared by its area" },
            gmt: { type: "string", description: "Its UTC offset, e.g. +3 or -5" },
          },
          required: ["translations", "shortName", "plate", "dialCode", "postCode", "gmt"],
          additionalProperties: false,
        },
        system: SYSTEM,
        prompt:
          `"${name.trim()}" is ${what}. ` +
          `Give its name in each of these languages (code: language): ${languages.map((l) => `${l.code}: ${l.label}`).join("; ")}. ` +
          "If no such place exists there, return empty strings everywhere.",
      })
    : null;

  const translations = alignTranslations(languages, answer?.translations, name);
  return {
    shortName: (answer?.shortName ?? "").toUpperCase().slice(0, 4),
    plate: (answer?.plate ?? "").slice(0, 4),
    name: englishOf(translations),
    translations,
    phoneCode: answer?.dialCode || inherited.phoneCode,
    postCode: answer?.postCode ?? "",
    gmt: utcOffset(answer?.gmt) || inherited.gmt,
  };
}

"use server";

import { z } from "zod";
import { generateJson } from "@/lib/ai/openai";

/*
 * The AI pass behind Add Language: the administrator types the language's
 * name, in any language ("turkish", "Türkçe", "كردي سوراني"), and the rest of
 * the form is filled in — the name in English and Arabic, the name in the
 * language itself, its BCP 47 code, direction and fallback. Every field stays
 * editable; nothing is saved until Add.
 *
 * Never fails: with no key, or any AI failure, it answers null and the form
 * stays as typed, for the person to fill in by hand.
 */

export type LanguageDraft = {
  code: string;
  nameEn: string;
  nameAr: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  fallback: "en" | "ar";
};

const draftZod = z.object({
  code: z.string(),
  nameEn: z.string(),
  nameAr: z.string(),
  nativeName: z.string(),
  direction: z.enum(["ltr", "rtl"]),
  fallback: z.enum(["en", "ar"]),
});

export async function generateLanguageDraftAction(typed: string): Promise<LanguageDraft | null> {
  const name = typed.trim();
  if (!name) return null;
  try {
    return await generateJson({
      name: "language_draft",
      schema: draftZod,
      jsonSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Its BCP 47 tag in canonical casing: the ISO 639-1 code where one exists (tr, fa), else ISO 639-3 (ckb), " +
              "with a script or region subtag only when it is part of what was typed (zh-Hant, pt-BR). " +
              "Kurdish alone is ku (Kurmanji); Sorani is ckb. Empty if this is not a language.",
          },
          nameEn: { type: "string", description: "Its name in English, properly written" },
          nameAr: { type: "string", description: "Its name in Arabic" },
          nativeName: { type: "string", description: "Its name in the language itself, in its own script" },
          direction: { type: "string", enum: ["ltr", "rtl"], description: "The direction its script is written in" },
          fallback: {
            type: "string",
            enum: ["en", "ar"],
            description: "ar for a language written in Arabic script or mostly spoken in Arab countries, else en",
          },
        },
        required: ["code", "nameEn", "nameAr", "nativeName", "direction", "fallback"],
        additionalProperties: false,
      },
      system:
        "You fill in reference data for an administrator's console. Answer only with facts you are sure of; " +
        "use an empty string for anything you are not sure of.",
      prompt: `A language typed by an administrator: "${name}".`,
    });
  } catch {
    return null;
  }
}

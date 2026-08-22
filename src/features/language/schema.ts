import { z } from "zod";

/**
 * A system language: a 2-letter code (shown in the black chip) and its name.
 * Shape mirrors the intended NestJS DTO so swapping the mock in api.ts for the
 * real endpoint needs no UI change.
 */
export const languageSchema = z.object({
  id: z.string(),
  code: z.string(), // e.g. "EN"
  name: z.string(), // e.g. "English"
});

export type Language = z.infer<typeof languageSchema>;

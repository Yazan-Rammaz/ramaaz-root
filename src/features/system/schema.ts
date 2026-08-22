import { z } from "zod";

/**
 * A system project (the rows under "System Projects"): a short code, its full
 * name, and a one-line category/description. Shape mirrors the intended NestJS
 * DTO so swapping the mock in api.ts for the real endpoint needs no UI change.
 */
export const systemSchema = z.object({
  id: z.string(),
  code: z.string(), // e.g. "rdb"
  name: z.string(), // e.g. "Ramaaz Digital Banking"
  description: z.string(), // e.g. "Payment Services Provider"
});

export type System = z.infer<typeof systemSchema>;

import { z } from "zod";

export const regionSchema = z.object({
  id: z.string(),
  // TODO: model the region fields to match the NestJS DTO.
  name: z.string(),
});

export type Region = z.infer<typeof regionSchema>;

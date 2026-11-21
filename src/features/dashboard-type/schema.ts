import { z } from "zod";

/*
 * The dashboard type business units sign in to — the System Dashboards Type
 * screen (XD "Center Dash" 54). There is one, Management, and it is fixed
 * (`api.ts`): this is its shape on the screen.
 */

export const dashboardTypeSchema = z.object({
  id: z.string(),
  /** 1–4 letters or digits — the chip in the list ("M"). */
  short_name: z.string(),
  name: z.record(z.string(), z.string()),
  /** Our glyph until a logo is uploaded (the logo is an SVG file). */
  logo: z.string(),
  all_countries: z.boolean(),
  countries: z.array(z.string()),
  /** The language its dashboards open in — one of the project's (`en`). */
  language: z.string(),
});
export type DashboardType = z.infer<typeof dashboardTypeSchema>;

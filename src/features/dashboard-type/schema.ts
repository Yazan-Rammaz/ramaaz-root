import { z } from "zod";

/*
 * A project's dashboard types — the System Dashboards Type screen (XD
 * "Center Dash" 54): Management, Partner, Business. Each has a logo (SVG),
 * a name in every language the project lists, the countries it is available
 * in, and the language its dashboards open in.
 *
 * ⚠️ There is no backend for this yet: the shape below is OUR PROPOSAL, kept
 * close to business types'. When the backend defines the routes, this schema
 * follows their contract and `api.ts` swaps the mock out.
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

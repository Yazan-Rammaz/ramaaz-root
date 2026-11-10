import { z } from "zod";

/*
 * A project's business types — the System Business Type screen, in three
 * kinds (its three tabs): who a person is to a business (Owner, Partner, …),
 * what a corporate place is (Office, Branch, …), and how a business works
 * with the system (Business Partner, Distributor, …).
 *
 * ⚠️ There is no backend for this yet: the shape below is OUR PROPOSAL, kept
 * close to the roles screen's (the same panel: short name, a name in every
 * language, countries it is available in). When the backend defines the
 * routes, this schema follows their contract and `api.ts` swaps the mock out.
 */

export const BUSINESS_KINDS = ["individual", "corporate", "work"] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

/** A name keyed by language code — every language the project lists. */
const nameSchema = z.record(z.string(), z.string());

export const businessTypeSchema = z.object({
  id: z.string(),
  kind: z.enum(BUSINESS_KINDS),
  /** 1–4 letters or digits — the chip in the list ("OWN"). */
  short_name: z.string(),
  name: nameSchema,
  /** Available in every country of the project, or only in `countries`. */
  all_countries: z.boolean(),
  countries: z.array(z.string()),
});
export type BusinessType = z.infer<typeof businessTypeSchema>;

/** 1–4 letters or digits. */
export const SHORT_NAME = /^[A-Za-z0-9]{1,4}$/;

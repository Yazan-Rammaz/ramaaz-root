import { z } from "zod";

/*
 * The Business Work Structure — the businesses the selected project serves,
 * as a tree (main business → companies → offices → branches), each with its
 * own management dashboard: who may reach it and how, its business admins,
 * and the project data it is given (XD "Root Dashboard home page" 9–40).
 *
 * ⚠️ There is no backend for this yet: every shape here is OUR PROPOSAL, read
 * off the design. When the backend defines the routes, this file follows
 * their contract and `api.ts` swaps the mock out.
 */

/* ───────────────────────────── The tree ───────────────────────────── */

export const structureNodeSchema: z.ZodType<StructureNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    /** A country code for a flag, or one of our glyphs (`regions/globe`). */
    flag: z.string().optional(),
    icon: z.string().optional(),
    /** Not open to this administrator yet — shown, but out of reach. */
    locked: z.boolean().optional(),
    children: z.array(structureNodeSchema),
  }),
);
export type StructureNode = {
  id: string;
  name: string;
  flag?: string;
  icon?: string;
  locked?: boolean;
  children: StructureNode[];
};

/* ─────────────────────────── A dashboard ─────────────────────────── */

/** Who may reach a dashboard, and how (the ⚙ tab; an admin's own ⚙ narrows it). */
export type AccessSettings = {
  method: "browser" | "application";
  model: "desktop" | "mobile";
  browsers: ("chrome" | "safari")[];
  conditions: ("regions" | "ip" | "mac" | "device" | "timeframe")[];
  ips: string;
  linkType: "permalink" | "type2" | "type3";
  contract: { required: boolean; which: "contract1" | "contract2" };
  verification: { required: boolean; which: "type1" | "type2" };
  loginType: "root" | "management";
  approve: boolean;
};

/**
 * Where a business admin stands, in order: the second Root approves → their
 * login info is sent → they sign in (link, code, face, ID, terms, pass code) →
 * Root reviews their files → approved.
 */
export const ADMIN_STAGES = ["approval", "send", "login", "review", "active"] as const;
export type AdminStage = (typeof ADMIN_STAGES)[number];

/** One line of an admin's progress: what happened and when (or how long it waited). */
export type LogLine = { text: string; at?: string; sub?: LogLine[] };

export type BusinessAdmin = {
  id: string;
  short: string;
  name: string;
  phone: string;
  ips: string;
  mac: string;
  device: string;
  secretWords: string;
  addedBy: string;
  approvedBy?: string;
  addedAt: string;
  stage: AdminStage;
  log: LogLine[];
  /** What the sign-in collected, once it has. */
  kyc?: { idType: string; country: string; name: string; nationalNumber: string; birthday: string };
};

/** The project data a dashboard is given (the Data Setting tab): a tree of picks. */
export type DataOption = { id: string; label: string; on: boolean; children?: DataOption[] };
export type DataGroup = { id: string; title: string; icon: string; options: DataOption[] };
export const DATA_TABS = ["regions", "currencies", "structure", "rbac", "business", "legal"] as const;
export type DataTab = (typeof DATA_TABS)[number];

export type Dashboard = {
  id: string;
  title: string;
  icon: string;
  allCountries: boolean;
  adminSeats: number;
  type: { short: string; name: string };
  workType: { short: string; name: string };
  languages: string[];
  language: string;
  link: string;
  access: AccessSettings;
  admins: BusinessAdmin[];
  data: Record<DataTab, DataGroup[]>;
};

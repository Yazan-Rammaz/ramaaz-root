import { z } from "zod";

/*
 * The Business Work Structure: the selected project's organisation (head
 * office → country offices → regional offices → branches) and, for each
 * level, the people who run it and how they sign in.
 *
 * The contract is the root backend's, `/v1/projects/{id}/…` (snake_case):
 *   backend docs/console-api/from-backend/console-api.md §5.5, §5.7–§5.16
 *   backend docs/business-structure/from-backend/2026-11-15-*.md (one per screen)
 *
 * ⚠️ As of 2026-11-15 these routes are "built on the console, not yet deployed
 * to staging". Every read is parsed here so the day they land, a shape that
 * differs fails loud — and only what the screen reads is required: the rest
 * is `.loose()`, so a field the backend adds never fails the page.
 *
 * The Data Setting tab reads RDB's settings through the operations route
 * (`project.settings.get` / `unit.settings.get`, 2026-11-17 §3).
 */

/** A name keyed by language code (`{ en, ar, … }`). */
export const nameMapSchema = z.record(z.string(), z.string());
export type NameMap = z.infer<typeof nameMapSchema>;

/* ───────────────────────────── Units ───────────────────────────── */

export const UNIT_KINDS = ["country", "region", "branch"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** A unit as it appears inside a grant, a policy or a shift. */
const unitRefSchema = z
  .object({
    id: z.string(),
    kind: z.string().optional(),
    type: z.string().optional(),
    name: nameMapSchema.optional(),
    status: z.string().optional(),
  })
  .loose();
export type UnitRef = z.infer<typeof unitRefSchema>;

/** One unit of `GET …/units`: the tree is built from `parent_id`, the screen from `kind`. */
export const unitSchema = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    type: z.string(),
    kind: z.string(),
    name: nameMapSchema,
    status: z.string(),
    /** Where it stands — for display only; access follows the tree. */
    place: z
      .object({
        country_id: z.string().nullable().optional(),
        region_id: z.string().nullable().optional(),
        name: nameMapSchema.optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type Unit = z.infer<typeof unitSchema>;

/* ───────────────────────────── Grants ───────────────────────────── */

const grantRoleSchema = z
  .object({ id: z.string(), short_name: z.string(), name: nameMapSchema, rank: z.number() })
  .loose();
export type GrantRole = z.infer<typeof grantRoleSchema>;

/** What a person holds in the project (§5.7). A `null` unit is the whole project — the head office. */
export const grantSchema = z
  .object({
    admin: z
      .object({
        id: z.string(),
        full_name: z.string(),
        full_name_ar: z.string().optional(),
        phone: z.string().optional(),
        /** A new phone not confirmed by a sign-in yet (§5.8a). */
        phone_unverified: z.boolean().optional(),
        has_secret_words: z.boolean().optional(),
        secret_words_set_at: z.string().nullable().optional(),
      })
      .loose(),
    assignments: z.array(
      z
        .object({
          unit: unitRefSchema.nullable(),
          roles: z.array(grantRoleSchema),
          permissions: z.array(z.object({ key: z.string(), status: z.string() }).loose()).optional(),
        })
        .loose(),
    ),
    manages: z.array(z.object({ unit: unitRefSchema.nullable() }).loose()).default([]),
    granted_at: z.string().optional(),
  })
  .loose();
export type Grant = z.infer<typeof grantSchema>;

/* ───────────────────────── Two-root approvals ───────────────────────── */

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REFUSED", "EXPIRED", "WITHDRAWN", "SUPERSEDED"] as const;

const personRefSchema = z.object({ id: z.string(), full_name: z.string() }).loose();

/** Appointing a general manager (§5.11): one root asks, the other decides. */
export const approvalSchema = z
  .object({
    id: z.string(),
    operation: z.string().optional(),
    status: z.string(),
    target: personRefSchema,
    requested_by: personRefSchema,
    requested_at: z.string(),
    expires_at: z.string().optional(),
    decided_by: personRefSchema.nullable().optional(),
    /** Who must decide while it waits, when only one can (§5.11); `null` otherwise. */
    decider: personRefSchema.nullable().optional(),
    decided_at: z.string().nullable().optional(),
    reason: z.string().optional(),
    /** Sent back on Approve: what is approved is exactly what was shown. */
    payload_hash: z.string(),
    proposed: grantSchema.partial({ admin: true }).nullable().optional(),
    current: grantSchema.partial({ admin: true }).nullable().optional(),
    may_decide: z.boolean(),
  })
  .loose();
export type Approval = z.infer<typeof approvalSchema>;

/* ───────────────────────── First sign-in approvals ───────────────────────── */

const extractedSchema = z
  .object({
    full_name: z.string().optional(),
    document_number: z.string().optional(),
    national_number: z.string().optional(),
    birth_date: z.string().optional(),
    expiry_date: z.string().optional(),
    country: z.string().optional(),
    country_iso3: z.string().optional(),
  })
  .loose();

/** A first sign-in waiting for somebody to agree (§5.12). `evidence` comes on the single read only. */
export const loginApprovalSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    subject: z
      .object({ id: z.string(), full_name: z.string(), phone: z.string().optional(), is_root: z.boolean().optional() })
      .loose(),
    requested_at: z.string(),
    expires_at: z.string().optional(),
    decided_by: personRefSchema.nullable().optional(),
    decided_at: z.string().nullable().optional(),
    may_decide: z.boolean(),
    evidence: z
      .object({
        reference_photo_url: z.string().nullable().optional(),
        face_capture_url: z.string().nullable().optional(),
        document: z
          .object({
            type: z.string().optional(),
            front_image_url: z.string().nullable().optional(),
            back_image_url: z.string().nullable().optional(),
            extracted: extractedSchema.nullable().optional(),
            submitted_at: z.string().optional(),
          })
          .loose()
          .nullable()
          .optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type LoginApproval = z.infer<typeof loginApprovalSchema>;

/** The pictures a login approval carries, by the name the image route takes. */
export const EVIDENCE_IMAGES = ["reference", "capture", "front", "back"] as const;
export type EvidenceImage = (typeof EVIDENCE_IMAGES)[number];

/* ───────────────────────────── A member ───────────────────────────── */

/** `GET …/members/{id}/photo` — `photo_url` may be absent while `has_photo` is true. */
export const memberPhotoSchema = z
  .object({ user_id: z.string().optional(), has_photo: z.boolean(), photo_url: z.string().optional() })
  .loose();

/** The onboarding timeline (§5.16): from the Get Started message to the first completed sign-in. */
export const timelineSchema = z
  .object({
    status: z.enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED"]).catch("NOT_STARTED"),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    attempts: z.number().optional(),
    totals: z
      .object({ total_ms: z.number(), person_ms: z.number(), system_ms: z.number(), approver_ms: z.number() })
      .loose()
      .optional(),
    events: z
      .array(
        z
          .object({
            at: z.string(),
            kind: z.string(),
            purpose: z.string().optional(),
            /** How a message went: `whatsapp` today (§5.16). */
            channel: z.string().optional(),
            stage: z.string().optional(),
            detail: z.string().optional(),
            waiting_on: z.string().optional(),
            duration_ms: z.number().optional(),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();
export type Timeline = z.infer<typeof timelineSchema>;
export type TimelineEvent = Timeline["events"][number];

/* ───────────────────────────── Contracts ───────────────────────────── */

/** A template as the list gives it (no body). Get Started offers the published ones. */
export const contractTemplateSchema = z
  .object({ id: z.string(), code: z.string(), version: z.string(), title: z.string(), status: z.string() })
  .loose();
export type ContractTemplate = z.infer<typeof contractTemplateSchema>;

/** A contract issued to a member (`GET /members/{id}/contracts`, §5.13), newest first. */
export const memberContractSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    type: z.string(),
    version: z.string(),
    title: z.string(),
    issued_at: z.string().optional(),
    signed_at: z.string().nullable().optional(),
    declines: z
      .array(
        z
          .object({ declined_at: z.string().optional(), clauses: z.array(z.object({ number: z.number() }).loose()).optional() })
          .loose(),
      )
      .optional(),
  })
  .loose();

/** One contract as the person read it (`GET …/members/{id}/contracts/{contractId}`, §5.13). */
export const memberContractTextSchema = z
  .object({
    text_source: z.string().optional(),
    greeting: z.string().nullable().optional(),
    clauses: z
      .array(z.object({ number: z.number(), text: z.string(), answer: z.string().nullable().optional() }).loose())
      .optional(),
  })
  .loose();

/** A clause as the person answered it: agreed (signed), disagreed (named in their latest refusal), or not yet. */
export type ContractClause = { number: number; text: string; answer: "agree" | "disagree" | null };
export type SignedContract = { title: string; status: string; issuedAt?: string; greeting?: string; clauses: ContractClause[] };

/* ───────────────────────────── Sign-in policy ───────────────────────────── */

export const WEEK_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

const hoursSchema = z.object({
  timezone: z.string(),
  days: z.array(z.string()),
  from: z.string(),
  to: z.string(),
});
export type SignInHours = z.infer<typeof hoursSchema>;

export const LINK_TYPES = ["PERMALINK", "TOKEN"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** A level's own settings: every field `null` (or absent) is "inherit". */
const ownPolicySchema = z
  .object({
    require_contract: z.boolean().nullable().optional(),
    contract_types: z.array(z.string()).nullable().optional(),
    require_face: z.boolean().nullable().optional(),
    require_id_document: z.boolean().nullable().optional(),
    require_first_login_approval: z.boolean().nullable().optional(),
    languages: z.array(z.string()).nullable().optional(),
    /**
     * The one language the dashboard opens in — the highlighted chip on ⓘ
     * (2026-11-21-work-structure-info-tab-answers.md §5). One of the languages
     * allowed at the level; `null` inherits. In `inherited`/`effective` it is
     * the nearest level's that is still allowed, or `null`.
     */
    default_language: z.string().nullable().optional(),
    max_admins: z.number().nullable().optional(),
    /** What Get Started sends (§5.8, §5.14): `TOKEN`, their own link, or `PERMALINK`, the shared portal. Nearest level wins; none is `TOKEN`. */
    link_type: z.string().nullable().optional(),
    /** How long a private code sent to the people here lives, in minutes; `null` is the deployment's own. Only lowers. */
    private_code_minutes: z.number().nullable().optional(),
    allowed_countries: z.array(z.string()).nullable().optional(),
    allowed_ips: z.array(z.string()).nullable().optional(),
    sign_in_hours: hoursSchema.nullable().optional(),
    max_session_minutes: z.number().nullable().optional(),
  })
  .loose();
export type OwnPolicy = z.infer<typeof ownPolicySchema>;

/** Inherited and effective: every field filled in, `null` when there is no restriction; hours are a list. */
const resolvedPolicySchema = ownPolicySchema.extend({
  require_contract: z.boolean().catch(false),
  require_face: z.boolean().catch(false),
  require_id_document: z.boolean().catch(false),
  require_first_login_approval: z.boolean().catch(false),
  sign_in_hours: z.array(hoursSchema).nullable().optional(),
});
export type ResolvedPolicy = z.infer<typeof resolvedPolicySchema>;

export const policySchema = z
  .object({
    unit: unitRefSchema.nullable().optional(),
    own: ownPolicySchema.nullable().transform((o) => o ?? {}),
    inherited: resolvedPolicySchema,
    effective: resolvedPolicySchema,
    updated_at: z.string().nullable().optional(),
    may_edit: z.boolean(),
  })
  .loose();
export type Policy = z.infer<typeof policySchema>;

/* ───────────────────────────── What the screen sends ───────────────────────────── */

/** An id from the backend, as it may go into a path. */
export const idSchema = z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/);

/** A level of the tree: a unit id, or `null` for the head office. */
export const levelSchema = idSchema.nullable();
export type Level = z.infer<typeof levelSchema>;

/** Add Business Admin (§5.8): the account and the roles it holds at this level, in one step. */
export const newMemberSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  full_name_ar: z.string().trim().max(200).optional(),
  phone: z.string().trim().min(5).max(32),
  email: z.string().trim().email().optional(),
  /** Stored at once and sent by the first Get Started (§5.10). */
  secret_words: z.string().trim().min(2).max(100).optional(),
  roles: z.array(idSchema).min(1),
});
export type NewMember = z.input<typeof newMemberSchema>;

/**
 * A reference photograph as a data URL — the server's own rule is a JPEG, PNG
 * or WebP of at most 2 MiB; the screen shrinks it to a JPEG well under that
 * first, because a Server Action takes 1 MB.
 */
export const photoDataUrlSchema = z
  .string()
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
  .max(1_000_000);

/** 2 to 100 characters; the backend checks the rest (and refuses the shared phrase). */
export const secretWordsSchema = z.string().trim().min(2).max(100);

/** Send Login Info: both optional. */
export const getStartedSchema = z.object({
  secret_words: secretWordsSchema.optional(),
  contract_type: z.string().regex(/^[A-Z][A-Z0-9_]{1,59}$/).optional(),
});
export type GetStartedInput = z.input<typeof getStartedSchema>;

const CIDR = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The level's COMPLETE own settings, as `PUT …/dashboard-policy` takes them. */
export const policyInputSchema = z.object({
  dashboard: z.literal("MANAGEMENT"),
  require_contract: z.boolean().nullable(),
  contract_types: z.array(z.string()).nullable(),
  require_face: z.boolean().nullable(),
  require_id_document: z.boolean().nullable(),
  require_first_login_approval: z.boolean().nullable(),
  languages: z.array(z.string().min(1)).min(1).nullable(),
  default_language: z.string().min(1).nullable().optional(),
  max_admins: z.number().int().min(1).nullable(),
  link_type: z.enum(LINK_TYPES).nullable().optional(),
  private_code_minutes: z.number().int().min(1).nullable().optional(),
  allowed_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).nullable(),
  allowed_ips: z.array(z.string().regex(CIDR)).nullable(),
  sign_in_hours: z
    .object({
      timezone: z.string().min(1),
      days: z.array(z.enum(WEEK_DAYS)).min(1),
      from: z.string().regex(HHMM),
      to: z.string().regex(HHMM),
    })
    .refine((h) => h.from < h.to)
    .nullable(),
  max_session_minutes: z.number().int().min(15).max(43200).nullable(),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

/* ───────────────────────────── What the screen shows ───────────────────────────── */

/** A row of the tree. The head office is the first, with `id: null`. */
export type StructureNode = {
  id: string | null;
  kind: "head" | UnitKind;
  name: NameMap;
  /** "North · Jahra" — the place's name, shown beside the unit's. */
  place?: NameMap;
  /** ISO2 for a flag, when the place is a country we know. */
  flag?: string;
  /** The country a unit stands in (its country office's flag) — a unit's ⓘ shows only it. */
  countryFlag?: string;
  /** `CLOSED`: greyed out and read-only. */
  closed: boolean;
  children: StructureNode[];
};

/**
 * Where a business admin stands, in order: the second Root approves → their
 * login info is sent → they sign in → (when first sign-ins wait) somebody
 * reviews their files → active.
 */
export const ADMIN_STAGES = ["approval", "send", "login", "review", "active"] as const;
export type AdminStage = (typeof ADMIN_STAGES)[number];

/** One line of an admin's progress: what happened, when, and the wait after it. */
export type LogLine = {
  text: string;
  at?: string;
  wait?: string;
  waitingOn?: string;
  /** `MESSAGE_FAILED`: the message never reached the person — an error, not a wait on them. */
  failed?: boolean;
  /** The provider's reason for a failed message: technical, so small print. */
  detail?: string;
};

/** A person at this level, put together from their grant, approvals, photo and timeline. */
export type BusinessAdmin = {
  id: string;
  name: string;
  nameAr?: string;
  phone?: string;
  /** The badge: their most senior role here. */
  short: string;
  roles: GrantRole[];
  grantedAt?: string;
  stage: AdminStage;
  /** A two-root appointment about them, while it waits. */
  approval?: Approval;
  /** Their approved appointment (asked, decided) — the first lines of their log. */
  appointment?: Approval;
  /** Their first sign-in, waiting for a decision — or the latest one, for the files. */
  loginApproval?: LoginApproval;
  hasPhoto: boolean;
  timeline?: Timeline;
  /** The latest Get Started message never arrived (`MESSAGE_FAILED`): send it again. */
  deliveryFailed?: boolean;
  /** The root who asked for them, and the one who approved it (head office appointments). */
  addedBy?: string;
  approvedBy?: string;
  /** Their latest contract and how they answered each clause (XD work structure 15, 20). */
  contract?: SignedContract;
  phoneUnverified?: boolean;
  hasSecretWords?: boolean;
  secretWordsSetAt?: string | null;
  /** Where their roles take effect (§5.10a); absent when it could not be read. */
  countries?: MemberCountries;
};

/** The roles a level may give (§5.14a): its own limit, the one above, and what is left. */
export const levelRolesSchema = z
  .object({
    all_roles: z.boolean(),
    roles: z.array(grantRoleSchema).default([]),
    inherited: z.object({ all_roles: z.boolean(), roles: z.array(z.union([z.string(), grantRoleSchema])).default([]) }).loose(),
    effective: z.array(grantRoleSchema).default([]),
    updated_at: z.string().nullable().optional(),
    may_edit: z.boolean(),
  })
  .loose();
export type LevelRoles = z.infer<typeof levelRolesSchema>;

/** The countries one person may act in (§5.10a): country units of the tree. */
export const memberCountriesSchema = z
  .object({
    all_countries: z.boolean(),
    countries: z.array(z.object({ id: z.string() }).loose()).default([]),
    may_edit: z.boolean(),
  })
  .loose();
export type MemberCountries = { all: boolean; ids: string[]; mayEdit: boolean };

/** Everything the panel of one level shows. */
export type LevelPanel = {
  level: Level;
  policy: Policy | null;
  admins: BusinessAdmin[];
  /** Roles that may be held at this level, most senior first. */
  roles: GrantRole[];
  /** Published contract templates, for Send Login Info. */
  templates: ContractTemplate[];
  /** The project's languages (codes), for the policy's language list. */
  languages: string[];
  /** The roles this level may give (Data Setting → System RBAC); `null` when not readable. */
  levelRoles: LevelRoles | null;
  /** The project's roles usable in this level's country — System RBAC's switches. */
  levelRoleChoices: GrantRole[];
  /** The project's country units (`/units`, kind country) — a person's countries choice. */
  countryUnits: { id: string; code?: string; name: NameMap }[];
  /** A unit's work type key (RDB `unit.get` → `workType`); the head office's is in its data settings. */
  workType?: string | null;
  /** Why part of the panel could not be read — the rest still shows. */
  unavailable: ("policy" | "admins" | "roles")[];
};

/* ───────────────────────────── Data Setting ───────────────────────────── */

/** The lists of RDB's settings (`project.settings.*` / `unit.settings.*`), in the order RDB writes them. */
export const SETTINGS_LISTS = [
  "levels",
  "currencies",
  "metals",
  "cryptoTokens",
  "businessTypes",
  "workTypes",
  "legalEntities",
  "departments",
  "adminLevels",
  "jobTitles",
] as const;
export type SettingsList = (typeof SETTINGS_LISTS)[number];

/** One item of a list: a level position (1–10), a currency id, or a catalog key. */
const settingsItem = z.union([z.string(), z.number()]);
export type SettingsItem = z.infer<typeof settingsItem>;
const settingsLists = {
  levels: z.array(settingsItem),
  currencies: z.array(settingsItem),
  metals: z.array(settingsItem),
  cryptoTokens: z.array(settingsItem),
  businessTypes: z.array(settingsItem),
  workTypes: z.array(settingsItem),
  legalEntities: z.array(settingsItem),
  departments: z.array(settingsItem),
  adminLevels: z.array(settingsItem),
  jobTitles: z.array(settingsItem),
} satisfies Record<SettingsList, z.ZodType>;

/**
 * A level's data settings as RDB holds them. Update sends them back COMPLETE —
 * every list, the ones this screen does not edit exactly as read — with
 * `updatedAt` as `expectedUpdatedAt` (`null` until first saved).
 */
export const rdbSettingsSchema = z
  .object({
    ...settingsLists,
    /**
     * The head office only, from RDB 1.20 (2026-11-21-head-office-countries-and-work-type.md):
     * where country offices may open (`"all"` or country ids), and its work type key.
     * Absent before 1.20 — then they are shown read-only and never sent.
     */
    countries: z.union([z.literal("all"), z.array(z.string())]).optional(),
    workType: z.string().nullable().optional(),
    /**
     * The head office only, RDB 1.21: a country id → the level positions allowed
     * there; a country with no entry uses `levels`. Absent before 1.21 — then
     * never sent (guide 1.21 §4).
     */
    levelsByCountry: z.record(z.string(), z.array(z.number())).optional(),
    updatedAt: z.string().nullable(),
  })
  .loose();
export type RdbSettings = z.infer<typeof rdbSettingsSchema>;

/**
 * A pick and its own picks. `value` is what it saves in its group's list; a
 * pick without one (Money, Individual, a country) only groups the others, and
 * a group without a `list` is shown as designed and not saved.
 */
export type DataOption = {
  id: string;
  label: string;
  on: boolean;
  value?: SettingsItem;
  /** Saves in this list instead of its group's (Gold, Silver and Crypto sit in the currencies group). */
  list?: SettingsList;
  /** Shown, not pickable: an inactive item a setting still names. */
  disabled?: boolean;
  /** A country on the head office's levels (1.21): its id, and whether it has its own entry. */
  countryId?: string;
  custom?: boolean;
  children?: DataOption[];
};
export type DataGroup = {
  id: string;
  title: string;
  icon: string;
  list?: SettingsList;
  /** The head office's levels, saved per country (`levelsByCountry`). */
  byCountry?: boolean;
  options: DataOption[];
};
// The design's five (XD work structure 21–25); RDB's legalEntities has no tab in it.
export const DATA_TABS = ["regions", "currencies", "structure", "rbac", "business"] as const;
export type DataTab = (typeof DATA_TABS)[number];
export type DataSettings = {
  tabs: Record<DataTab, DataGroup[]>;
  /** As read; `null` when RDB could not be read — then nothing on the tab saves. */
  settings: RdbSettings | null;
  /** The project's OPEN countries — the head office's countries choice saves their ids. */
  countryChoices: { id: string; code: string }[];
  /** ACTIVE work types — the head office's Business Work Type. */
  workTypes: { key: string; short: string; name: string }[];
  /** Whether this person may save these settings: only the levels above may (guide 1.21 §1). */
  mayEdit: boolean;
};

/** What Update sends: every list, complete. */
export const settingsInputSchema = z.object({
  ...settingsLists,
  countries: z.union([z.literal("all"), z.array(z.string()).max(300)]).optional(),
  workType: z.string().nullable().optional(),
  levelsByCountry: z.record(z.string(), z.array(z.number())).optional(),
  expectedUpdatedAt: z.string().nullable(),
});
export type SettingsInput = z.infer<typeof settingsInputSchema>;

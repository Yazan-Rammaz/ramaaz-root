import "server-only";
import { z } from "zod";
import { listLanguages } from "@/features/language/api";
import { listRoleCountries, listRoles } from "@/features/role/api";
import type { Role } from "@/features/role/schema";
import { backendFetch } from "@/lib/api/backend";
import { getLocale, getTranslations } from "next-intl/server";
import { activeOperations, oneParam, readAllPages, readOperation, readShared, readAllPagesShared } from "@/lib/api/operations";
import { correlationId, errorCode } from "@/lib/auth/errors";
import { ApiError } from "@/lib/api/server";
import {
  approvalSchema,
  contractTemplateSchema,
  levelRolesSchema,
  memberContractSchema,
  memberContractTextSchema,
  memberCountriesSchema,
  grantSchema,
  loginApprovalSchema,
  memberPhotoSchema,
  nameMapSchema,
  policySchema,
  rdbSettingsSchema,
  verificationSchema,
  timelineSchema,
  unitSchema,
  type Approval,
  type SignedContract,
  type BusinessAdmin,
  type DataGroup,
  type DataOption,
  type DataSettings,
  type DataTab,
  type RdbSettings,
  type SettingsItem,
  type SettingsList,
  type Grant,
  type GrantRole,
  type Level,
  type LevelPanel,
  type LoginApproval,
  type StructureNode,
  type Unit,
  type Verification,
} from "./schema";
import { getStartedFailed, pickName } from "./timeline";

/**
 * Single place the business work structure is read. Server-only.
 *
 * The root backend's routes for the selected project (`backendFetch` adds
 * `/v1/projects/{id}`):
 *
 *   GET /units                          the tree (console-api.md §5.5)
 *   GET [/units/{id}]/dashboard-policy  a level's sign-in policy (§5.14)
 *   GET /grants                         who holds what (§5.7)
 *   GET /approvals                      general-manager appointments: waiting, and who asked and approved (§5.11)
 *   GET /login-approvals                first sign-ins waiting, and decided (§5.12)
 *   GET /members/{id}/photo | /timeline one person (§5.9, §5.16)
 *   GET /contract-templates             what Send Login Info may issue (§5.13)
 *
 * Each read fails on its own: a level whose policy cannot be read still lists
 * its people, and the head office row is there even when `/units` is not.
 */

const list = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });
const enc = encodeURIComponent;
const levelPath = (level: Level) => (level === null ? "" : `/units/${enc(level)}`);

/* ───────────────────────────── The tree ───────────────────────────── */

const countryCodeSchema = z.object({ id: z.string(), code: z.string() }).loose();

const geoSchema = z.object({ id: z.string(), name: z.record(z.string(), z.string()).optional() }).loose();

/** RDB's countries: id → ISO2 (the flags) and id → name (a unit's place). Empty when RDB cannot be read. */
async function countries(): Promise<{
  codes: Map<string, string>;
  names: Map<string, Record<string, string>>;
  /** ISO2 of the project's OPEN countries (a closed one has `deletedAt`) — the flag strips. */
  open: string[];
}> {
  try {
    const rows = z
      .array(
        countryCodeSchema.extend({
          name: z.record(z.string(), z.string()).optional(),
          deletedAt: z.string().nullable().optional(),
        }),
      )
      .parse(await readAllPagesShared("country.list", { query: { includeDeleted: "true" } }));
    return {
      codes: new Map(rows.map((c) => [c.id, c.code.toUpperCase()])),
      names: new Map(rows.flatMap((c) => (c.name ? [[c.id, c.name] as const] : []))),
      open: rows.filter((c) => !c.deletedAt).map((c) => c.code.toUpperCase()),
    };
  } catch {
    return { codes: new Map(), names: new Map(), open: [] };
  }
}

/** The names of the regions of these countries, by id — a regional office's or a branch's place. */
async function regionNames(countryIds: string[]): Promise<Map<string, Record<string, string>>> {
  const lists = await Promise.all(
    countryIds.map((id) =>
      // Shared for a minute (lib/api/operations): RDB answers these one at a time, one per
      // country, and they held the tree back ~0.5 s each on every visit (2026-11-24).
      readAllPagesShared("region.list", { params: { unit_id: id } })
        .then((rows) => z.array(geoSchema).parse(rows))
        .catch(() => []),
    ),
  );
  return new Map(lists.flat().flatMap((r) => (r.name ? [[r.id, r.name] as const] : [])));
}

/** A unit as RDB's `unit.list` answers it (camelCase; the place's name is not on it). */
const rdbUnitSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    kind: z.string(),
    type: z.string().optional(),
    name: z.record(z.string(), z.string()),
    status: z.string(),
    placeId: z.string().nullable().optional(),
    placeCountryId: z.string().nullable().optional(),
  })
  .loose();

/**
 * The business tree. ⚠️ UNTIL THE SWITCH it is read straight from RDB, as the
 * head office (`unit.list`): the console's own `/units` still mirrors the
 * geography until that day (2026-11-17-business-structure-page.md). A project
 * that does not declare `unit.list` — RDB after it retires it, or another
 * project — falls back to the console's `/units`.
 */
async function readUnits(): Promise<Unit[]> {
  try {
    const rows = z.array(rdbUnitSchema).parse(await readAllPages("unit.list"));
    const { names: countryNames } = await countries();
    const regionIds = [...new Set(rows.flatMap((u) => (u.placeCountryId ? [u.placeCountryId] : [])))];
    const regions = await regionNames(regionIds);
    return rows.map((u) => ({
      id: u.id,
      parent_id: u.parentId,
      type: u.type ?? u.kind,
      kind: u.kind,
      name: u.name,
      status: u.status,
      place: u.placeId
        ? {
            country_id: u.placeCountryId ?? u.placeId,
            region_id: u.placeId === u.placeCountryId ? null : u.placeId,
            name: countryNames.get(u.placeId) ?? regions.get(u.placeId),
          }
        : null,
    }));
  } catch (error) {
    if (errorCode(error) !== "OPERATION_NOT_DECLARED") {
      console.warn("[work-structure] unit.list unavailable:", error instanceof Error ? error.message : error);
    }
  }
  return list(unitSchema).parse(await backendFetch.get<unknown>("/units")).data;
}

export type Structure = {
  tree: StructureNode[];
  units: Unit[];
  /** ISO2 codes of the project's open countries (RDB) — the flag strips. */
  countries: string[];
  /** When the console last mirrored the tree (`connection.units_fetched_at`). */
  fetchedAt?: string;
};

/**
 * The head office, and under it the units by `parent_id`. `RETIRED` units are
 * left out (they live on only inside grants); the top of what the caller sees
 * has `parent_id: null`, so those are the head office's children.
 */
export async function loadStructure(): Promise<Structure> {
  const [units, { codes, open }, project] = await Promise.all([
    readUnits().catch((error) => {
      console.warn("[work-structure] units unavailable:", error instanceof Error ? error.message : error);
      return [] as Unit[];
    }),
    countries(),
    backendFetch
      .get<unknown>("")
      .then((raw) => z.object({ connection: z.object({ units_fetched_at: z.string().nullable().optional() }).loose().nullable().optional() }).loose().parse(raw))
      .catch(() => null),
  ]);

  const live = units.filter((u) => u.status !== "RETIRED");
  const ids = new Set(live.map((u) => u.id));
  const node = (u: Unit, countryFlag?: string): StructureNode => {
    const flag = u.kind === "country" && u.place?.country_id ? codes.get(u.place.country_id) : undefined;
    return {
    id: u.id,
    kind: u.kind === "country" || u.kind === "region" ? u.kind : "branch",
    name: u.name,
    place: u.place?.name,
    flag,
    countryFlag: flag ?? countryFlag,
    closed: u.status === "CLOSED",
    // A branch never has children; nothing stands under it.
    children: u.kind === "branch" ? [] : live.filter((c) => c.parent_id === u.id).map((c) => node(c, flag ?? countryFlag)),
    };
  };
  const top = live.filter((u) => u.parent_id === null || !ids.has(u.parent_id)).map((u) => node(u));

  return {
    tree: [{ id: null, kind: "head", name: {}, closed: false, children: top }],
    units: live,
    // The project's countries, as the design's flag strip shows them (XD work
    // structure 2) — RDB's open countries, not only those with an office yet.
    countries: [...new Set(open)],
    fetchedAt: project?.connection?.units_fetched_at ?? undefined,
  };
}

/* ───────────────────────────── One level ───────────────────────────── */

const sameUnit = (unit: { id: string } | null, level: Level) => (unit?.id ?? null) === level;

/** Somebody who holds a role here, or manages it. */
const isHere = (g: Grant, level: Level) =>
  g.assignments.some((a) => sameUnit(a.unit, level)) || g.manages.some((m) => sameUnit(m.unit, level));

/** The country office a unit stands under — a role limited to some countries is held only inside them. */
function countryOf(level: Level, units: Unit[]): string[] {
  let unit = units.find((u) => u.id === level);
  while (unit && unit.kind !== "country") unit = units.find((u) => u.id === unit!.parent_id);
  // Before the switch a role's countries are geography ids — the country the office stands in.
  return unit ? [unit.id, ...(unit.place?.country_id ? [unit.place.country_id] : [])] : [];
}

/**
 * The roles that may be held here, most senior first. The head office takes
 * only roles available in every country (one limited to some can never be
 * held across the whole project); a unit takes those, plus the ones limited
 * to its country.
 */
function rolesFor(level: Level, roles: Role[], units: Unit[]): GrantRole[] {
  const country = level === null ? [] : countryOf(level, units);
  return roles
    .filter((r) => r.all_countries || r.countries.some((c) => country.includes(c.id)))
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ id: r.id, short_name: r.short_name, name: r.name, rank: r.rank }));
}

function rolesHere(g: Grant, level: Level): GrantRole[] {
  return g.assignments
    .filter((a) => sameUnit(a.unit, level))
    .flatMap((a) => a.roles)
    .sort((a, b) => a.rank - b.rank);
}

/** An appointment about somebody at this level: what it proposes names it. */
const proposesHere = (a: Approval, level: Level) =>
  !!a.proposed &&
  ((a.proposed.assignments ?? []).some((x) => sameUnit(x.unit, level)) ||
    (a.proposed.manages ?? []).some((m) => sameUnit(m.unit, level)));

async function memberExtras(id: string) {
  const [photo, timeline] = await Promise.all([
    backendFetch
      .get<unknown>(`/members/${enc(id)}/photo`)
      .then((raw) => memberPhotoSchema.parse(raw))
      .catch(() => null),
    backendFetch
      .get<unknown>(`/members/${enc(id)}/timeline`)
      .then((raw) => timelineSchema.parse(raw))
      .catch(() => undefined),
  ]);
  return { hasPhoto: photo?.has_photo ?? false, timeline };
}

/** One first-sign-in approval with its evidence (the list carries none). */
/**
 * First sign-ins, pending AND approved, newest first. Without a `status` the
 * list now answers only PENDING, so an approved person's sign-in — the one
 * their captured face and documents hang on — fell off it and their Files
 * went empty. Asked for both, merged by id.
 */
async function readLoginApprovals(): Promise<LoginApproval[]> {
  const lists = await Promise.all(
    ["PENDING", "APPROVED"].map((status) =>
      backendFetch.get<unknown>(`/login-approvals?status=${status}`).then((raw) => list(loginApprovalSchema).parse(raw).data),
    ),
  );
  const byId = new Map(lists.flat().map((l) => [l.id, l] as const));
  return [...byId.values()].sort((x, y) => Date.parse(y.requested_at) - Date.parse(x.requested_at));
}

/** A member's passed face check and document — audited on every read; see verificationSchema. */
export async function getMemberVerification(userId: string): Promise<Verification> {
  return verificationSchema.parse(await backendFetch.get<unknown>(`/members/${enc(userId)}/verification`));
}

export async function getLoginApproval(id: string): Promise<LoginApproval> {
  return loginApprovalSchema.parse(await backendFetch.get<unknown>(`/login-approvals/${enc(id)}`));
}

const safe = <T>(p: Promise<T>, what: string): Promise<T | null> =>
  p.catch((error) => {
    // One flat line with the backend's correlation id — what its team needs to find the request.
    console.warn(
      `[work-structure] ${what} unavailable: status=${error instanceof ApiError ? error.status : "-"} code=${errorCode(error) ?? "-"} correlation_id=${correlationId(error) ?? "-"} detail=${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });

/**
 * Everything the panel of one level shows. Its people are put together from
 * four places, because a person's state is spread across them:
 *
 *   pending appointment (head office)   → approval: the other root decides
 *   holder, no Get Started on record    → send
 *   holder, signing in                  → login
 *   first sign-in waiting for approval  → review
 *   first sign-in completed             → active
 *
 * Somebody added at the head office holds NOTHING until the other root
 * approves (`202`), so they are not in `/grants` yet: they come from the
 * appointment.
 */
export async function loadLevel(level: Level, unitsRead: Unit[] | Promise<Unit[]>): Promise<LevelPanel> {
  const [policy, grants, approvals, logins, roles, templates, languages, unitInfo, levelRoles, countryUnits] = await Promise.all([
    safe(backendFetch.get<unknown>(`${levelPath(level)}/dashboard-policy`).then((raw) => policySchema.parse(raw)), "policy"),
    safe(backendFetch.get<unknown>("/grants").then((raw) => list(grantSchema).parse(raw).data), "grants"),
    level === null
      ? safe(backendFetch.get<unknown>("/approvals").then((raw) => list(approvalSchema).parse(raw).data), "approvals")
      : Promise.resolve([] as Approval[]),
    safe(readLoginApprovals(), "login approvals"),
    safe(listRoles(), "roles"),
    safe(
      backendFetch
        .get<unknown>("/contract-templates?status=PUBLISHED")
        .then((raw) => list(contractTemplateSchema).parse(raw).data.filter((t) => t.status === "PUBLISHED")),
      "contract templates",
    ),
    safe(listLanguages(), "languages"),
    // A unit's own record in RDB, for its Business Work Type (ⓘ).
    level === null
      ? Promise.resolve(null)
      : safe(
          oneParam("unit.get", level, "unit_id")
            .then((params) => readOperation("unit.get", { params }))
            .then((raw) => z.object({ workType: z.string().nullable().optional() }).loose().parse(raw)),
          "unit",
        ),
    safe(backendFetch.get<unknown>(`${levelPath(level)}/level-roles`).then((raw) => levelRolesSchema.parse(raw)), "level roles"),
    safe(listRoleCountries(), "country units"),
  ]);

  // The latest first sign-in per person (newest first, as the backend lists them).
  const loginBy = new Map<string, LoginApproval>();
  for (const l of logins ?? []) if (!loginBy.has(l.subject.id)) loginBy.set(l.subject.id, l);

  const holders = (grants ?? []).filter((g) => isHere(g, level));
  const pending = (approvals ?? []).filter((a) => a.status === "PENDING" && proposesHere(a, level));
  // Who asked for each person, and who approved it — the latest decided appointment (newest first).
  const appointedBy = new Map<string, Approval>();
  for (const a of approvals ?? []) if (a.status === "APPROVED" && !appointedBy.has(a.target.id)) appointedBy.set(a.target.id, a);

  const admins: BusinessAdmin[] = await Promise.all([
    ...holders.map(async (g): Promise<BusinessAdmin> => {
      const extras = await memberExtras(g.admin.id);
      const login = loginBy.get(g.admin.id);
      const approval = pending.find((a) => a.target.id === g.admin.id);
      const held = rolesHere(g, level);
      const status = extras.timeline?.status;
      // The Get Started message never arrived: the step is Send Login Info again.
      const deliveryFailed = getStartedFailed(extras.timeline);
      return {
        id: g.admin.id,
        name: g.admin.full_name,
        nameAr: g.admin.full_name_ar,
        phone: g.admin.phone,
        short: held[0]?.short_name ?? "—",
        roles: held,
        grantedAt: g.added_at ?? g.granted_at,
        stage:
          login?.status === "PENDING"
            ? "review"
            : status === "COMPLETED"
              ? "active"
              : status === "IN_PROGRESS" && !deliveryFailed
                ? "login"
                : "send",
        approval,
        appointment: appointedBy.get(g.admin.id),
        addedBy: g.added_by?.full_name ?? (approval ?? appointedBy.get(g.admin.id))?.requested_by.full_name,
        approvedBy: g.approved_by?.full_name ?? appointedBy.get(g.admin.id)?.decided_by?.full_name,
        noApproval: g.approved_by === null && !approval,
        loginApproval: login,
        deliveryFailed,
        phoneUnverified: g.admin.phone_unverified,
        hasSecretWords: g.admin.has_secret_words,
        secretWordsSetAt: g.admin.secret_words_set_at,
        ...extras,
      };
    }),
    // Appointments of people who hold nothing here yet.
    ...pending
      .filter((a) => !holders.some((g) => g.admin.id === a.target.id))
      .map(async (a): Promise<BusinessAdmin> => {
        const proposed = (a.proposed?.assignments ?? []).filter((x) => sameUnit(x.unit, level)).flatMap((x) => x.roles);
        const extras = await memberExtras(a.target.id);
        return {
          id: a.target.id,
          name: a.target.full_name,
          short: proposed[0]?.short_name ?? "—",
          roles: proposed,
          grantedAt: a.requested_at,
          stage: "approval",
          approval: a,
          addedBy: a.requested_by.full_name,
          hasPhoto: extras.hasPhoto,
        };
      }),
  ]);

  // The rest of each person's panel, ALL AT ONCE (2026-11-24). These were three
  // rounds one after another — the first sign-in's evidence, then the contract and
  // the countries — and the evidence was itself read one sign-in at a time, up to
  // five in a row per person: about two seconds of waiting on the head office.
  // None depends on another; each needs only the person's stage, known above.
  //
  // First sign-in with its evidence, for Files and Review:
  //   waiting for review → the pending one: it is what Root is judging;
  //   otherwise → the newest that actually CARRIES evidence. A later attempt
  //   (expired, refused, a test) can hold no face and no document, and taking
  //   the newest blindly emptied the Files of somebody already verified. The
  //   candidates are read together and the first with evidence wins, in order.
  const hasEvidence = (l: LoginApproval) =>
    !!(l.evidence?.face_capture_url || l.evidence?.reference_photo_url || l.evidence?.document?.front_image_url);
  await Promise.all([
    ...admins.map(async (a) => {
      if (!a.loginApproval) return;
      const mine = (logins ?? []).filter((l) => l.subject.id === a.id);
      const candidates = a.loginApproval.status === "PENDING" ? [a.loginApproval] : mine.slice(0, 5);
      const fulls = await Promise.all(candidates.map((c) => safe(getLoginApproval(c.id), "login approval")));
      const pick = fulls.find((x) => x && hasEvidence(x)) ?? fulls[0];
      if (pick) a.loginApproval = pick;
    }),
    // Their latest contract: only someone past Get Started can have signed one.
    ...admins.map(async (a) => {
      if (a.stage === "approval" || a.stage === "send") return;
      a.contract = (await safe(memberContract(a), "contract")) ?? undefined;
    }),
    // Where each person's roles take effect (§5.10a).
    ...admins.map(async (a) => {
      if (a.stage === "approval") return;
      const c = await safe(
        backendFetch.get<unknown>(`/members/${enc(a.id)}/countries`).then((raw) => memberCountriesSchema.parse(raw)),
        "member countries",
      );
      if (c) a.countries = { all: c.all_countries, ids: c.countries.map((x) => x.id), mayEdit: c.may_edit };
    }),
  ]);

  // Needed only here, for which roles this level may give: the tree may still be reading.
  const units = await unitsRead;
  return {
    level,
    policy,
    admins,
    // Only what this level may give (§5.14a), when its limit could be read.
    roles: roles
      ? rolesFor(level, roles, units).filter((r) => !levelRoles || levelRoles.effective.some((e) => e.id === r.id))
      : [],
    levelRoles,
    levelRoleChoices: roles ? rolesFor(level, roles, units) : [],
    countryUnits: (countryUnits ?? []).filter((c) => !c.closed).map((c) => ({ id: c.id, code: c.code, name: c.name })),
    templates: templates ?? [],
    languages: (languages ?? []).filter((l) => l.status !== "INACTIVE").map((l) => l.code),
    workType: unitInfo?.workType ?? null,
    unavailable: [
      ...(policy ? [] : (["policy"] as const)),
      ...(grants ? [] : (["admins"] as const)),
      ...(roles ? [] : (["roles"] as const)),
    ],
  };
}

/* ───────────────────────────── Contracts ───────────────────────────── */

/**
 * A member's latest contract, whole, as the backend serves it (§5.13): the
 * list names it, and the single read gives its greeting and clauses exactly as
 * the person was shown them, with each answer. Nothing is filled or split
 * here. Before the person has read it (`text_source: "NONE"`), or while the
 * single read is not on staging, there is no text to show.
 */
async function memberContract(admin: BusinessAdmin): Promise<SignedContract | undefined> {
  const contracts = list(memberContractSchema).parse(await backendFetch.get<unknown>(`/members/${enc(admin.id)}/contracts`)).data;
  const c = contracts.find((x) => x.status === "SIGNED" || x.status === "ISSUED");
  if (!c) return undefined;
  const read = memberContractTextSchema.parse(
    await backendFetch.get<unknown>(`/members/${enc(admin.id)}/contracts/${enc(c.id)}`),
  );
  return {
    title: c.title,
    status: c.status,
    issuedAt: c.issued_at ?? undefined,
    greeting: read.greeting ?? undefined,
    clauses: (read.clauses ?? []).map((x) => ({
      number: x.number,
      text: x.text,
      answer: x.answer === "AGREED" ? "agree" : x.answer === "DECLINED" ? "disagree" : null,
    })),
  };
}

/* ───────────────────────────── Pictures ───────────────────────────── */

/** A member's reference photograph — a fresh signed URL on every read. */
export async function memberPhotoUrl(userId: string): Promise<string | undefined> {
  return memberPhotoSchema.parse(await backendFetch.get<unknown>(`/members/${enc(userId)}/photo`)).photo_url;
}

/* ───────────────────────────── Data Setting ───────────────────────────── */

/** A designed pick with no backend list yet: shown, never saved. */
const opt = (label: string, on = true, children?: DataOption[]): DataOption => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  label,
  on,
  ...(children ? { children } : {}),
});
const group = (id: string, title: string, icon: string, options: DataOption[], list?: SettingsList): DataGroup => ({
  id,
  title,
  icon,
  options,
  ...(list ? { list } : {}),
});

/** A catalog item (`business_type.list`, `department.list`, …): a permanent `key`, a name, where it may be used. */
const catalogItemSchema = z
  .object({
    key: z.string(),
    name: nameMapSchema,
    status: z.string().optional(),
    countries: z.union([z.literal("all"), z.array(z.string())]).optional(),
    /** `department.list`: the department it sits under. */
    parentKey: z.string().nullable().optional(),
    /** `business_type.list`: `individual` or `corporate`. */
    group: z.string().optional(),
    shortName: z.string().optional(),
  })
  .loose();
type CatalogItem = z.infer<typeof catalogItemSchema>;

const currencyItemSchema = z
  .object({ id: z.string(), name: nameMapSchema, deletedAt: z.string().nullable().optional() })
  .loose();

const countryLevelsSchema = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    name: nameMapSchema.optional(),
    deletedAt: z.string().nullable().optional(),
    levels: z.array(z.object({ position: z.number(), regionType: z.string() }).loose()).optional(),
  })
  .loose();

/** A metal (`metal.list`) or crypto token (`crypto_token.list`), RDB 1.21. */
const coinSchema = z
  .object({ id: z.string(), symbol: z.string(), name: nameMapSchema, network: z.string().optional(), status: z.string().optional() })
  .loose();
type Coin = z.infer<typeof coinSchema>;
/** A list answered bare or paged (`{ items }`): the paging comes with RDB's guide. */
const itemsOf = (raw: unknown): unknown => (raw && typeof raw === "object" && "items" in raw ? (raw as { items: unknown }).items : raw);

/** The caller's reach on the project (`GET /v1/projects/{id}` → `my_access`, §5.1). */
const myAccessSchema = z
  .object({
    my_access: z
      .object({
        everything: z.boolean(),
        assignments: z
          .array(
            z
              .object({
                unit: z.object({ id: z.string() }).loose().nullable(),
                permissions: z.array(z.object({ key: z.string(), status: z.string().optional() }).loose()).optional(),
              })
              .loose(),
          )
          .default([]),
      })
      .loose(),
  })
  .loose();

/** A read that may fail on its own: logged, and read as empty. */
async function orEmpty<T>(read: Promise<T[]>, what: string): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    console.warn(`[work-structure] data setting: ${what} unavailable:`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** A level's data settings: the head office's (`project.settings.get`) or a unit's (`unit.settings.get`). */
async function readSettings(level: Level): Promise<RdbSettings> {
  const raw =
    level === null
      ? await readOperation("project.settings.get")
      : await readOperation("unit.settings.get", { params: await oneParam("unit.settings.get", level, "unit_id") });
  return rdbSettingsSchema.parse(raw);
}

/** Is this RDB's head office? A country office's parent may be written either way. */
const isHead = (parentId: string | null | undefined) => !parentId || parentId === "*";

/**
 * The Data Setting tab of a level (XD work structure 21–25), from RDB
 * (2026-11-17-business-structure-page.md §3). Each list offers what the
 * backend says it may: the head office every ACTIVE catalog item, every
 * currency and every level position; a unit only what its country allows and
 * its parent holds — anything wider is refused, so it is not offered.
 *
 * Wired: levels, currencies, departments (with sub-departments), admin levels,
 * job titles, work types, business types (by group). Shown as designed and not
 * saved, until RDB or the root backend can hold them (to-backend
 * 2026-11-21-work-structure-data-setting.md): per-country levels on the head
 * office, crypto, gold, silver, RBAC. `metals`, `cryptoTokens` and
 * `legalEntities` go back on Update exactly as read.
 */
export async function loadDataSettings(level: Level, units: Unit[]): Promise<DataSettings> {
  const [t, locale] = await Promise.all([getTranslations("work.data"), getLocale()]);
  const unit = level === null ? undefined : units.find((u) => u.id === level);
  const countryId = unit?.place?.country_id ?? undefined;

  const [settings, parent, access, operations, countries, currencies, ...catalogs] = await Promise.all([
    readSettings(level).catch((error: unknown) => {
      console.warn("[work-structure] data setting: settings unavailable:", error instanceof Error ? error.message : error);
      return null;
    }),
    unit ? readSettings(isHead(unit.parent_id) ? null : unit.parent_id).catch(() => null) : Promise.resolve(null),
    // The caller's own reach: who may save (guide 1.21 §1).
    backendFetch
      .get<unknown>("")
      .then((raw) => myAccessSchema.parse(raw).my_access)
      .catch(() => null),
    activeOperations().catch(() => new Set<string>()),
    orEmpty(
      readAllPagesShared("country.list").then((rows) => z.array(countryLevelsSchema).parse(rows).filter((c) => !c.deletedAt)),
      "country.list",
    ),
    orEmpty(
      countryId
        ? readShared("country.currency.list", { params: { id: countryId } }).then((rows) =>
            z.array(z.object({ currency: currencyItemSchema }).loose()).parse(rows).map((l) => l.currency),
          )
        : readAllPagesShared("currency.list").then((rows) => z.array(currencyItemSchema).parse(rows).filter((c) => !c.deletedAt)),
      "currencies",
    ),
    ...(["department.list", "admin_level.list", "job_title.list", "work_type.list", "business_type.list", "legal_entity.list"] as const).map((name) =>
      orEmpty(
        readShared(name).then((rows) => z.array(catalogItemSchema).parse(rows)),
        name,
      ),
    ),
  ]);
  const [departments, adminLevels, jobTitles, workTypes, businessTypes, legalEntities] = catalogs as CatalogItem[][];

  // Metals and crypto tokens: real lists once RDB serves them (guide 1.21 §5).
  const hasLists = operations.has("metal.list") && operations.has("crypto_token.list");
  const [metals, tokens] = hasLists
    ? await Promise.all([
        orEmpty(readShared("metal.list").then((raw) => z.array(coinSchema).parse(itemsOf(raw))), "metal.list"),
        orEmpty(readShared("crypto_token.list").then((raw) => z.array(coinSchema).parse(itemsOf(raw))), "crypto_token.list"),
      ])
    : [[], []];

  // Only the levels above may save a level's data settings (guide 1.21 §1): the
  // head office and a country office need Root or the permission project-wide;
  // a regional office or a branch also takes it at one of its ancestors.
  const ancestors = new Set<string>();
  for (let p = unit?.parent_id; p && !isHead(p); p = units.find((u) => u.id === p)?.parent_id) ancestors.add(p);
  const holds = (a: { permissions?: { key: string; status?: string }[] }) =>
    !!a.permissions?.some((x) => x.key === "business_settings:write" && (x.status ?? "ACTIVE") === "ACTIVE");
  const mayEdit =
    !!access &&
    (access.everything ||
      access.assignments.some(
        (a) => holds(a) && (a.unit === null || (unit?.kind !== "country" && level !== null && ancestors.has(a.unit.id))),
      ));

  const own = (list: SettingsList) => new Set<SettingsItem>(settings?.[list] ?? []);
  // A unit may only narrow its parent; with the parent unread, the backend's refusal is the guard.
  const allowed = (list: SettingsList, value: SettingsItem) => !unit || !parent || parent[list].includes(value);
  const usable = (list: SettingsList) => (i: CatalogItem) =>
    (i.status ?? "ACTIVE") === "ACTIVE" &&
    (!countryId || !i.countries || i.countries === "all" || i.countries.includes(countryId)) &&
    allowed(list, i.key);
  const pick = (list: SettingsList, value: SettingsItem, label: string, children?: DataOption[]): DataOption => ({
    id: `${list}-${value}`,
    label,
    on: own(list).has(value),
    value,
    ...(children?.length ? { children } : {}),
  });
  const catalog = (list: SettingsList, items: CatalogItem[]) =>
    items.filter(usable(list)).map((i) => pick(list, i.key, pickName(i.name, locale)));
  const groupOption = (id: string, label: string, children: DataOption[]): DataOption => ({
    id,
    label,
    on: children.some((c) => c.on),
    children,
  });

  // Levels: the head office holds ONE list of positions for the whole project,
  // so each country shows the positions it has, picked independently on the
  // screen; Update saves every position picked under any country, and read
  // back a saved position is on wherever it appears. A unit shows its own country's.
  // RDB 1.21: the head office keeps levels per country (`levelsByCountry`); a
  // country with no entry follows the default `levels`, and says so.
  const byCountry = level === null && settings?.levelsByCountry !== undefined ? settings.levelsByCountry : undefined;
  const levelOptions = countries
    .filter((c) => !countryId || c.id === countryId)
    .map((c) => {
      const entry = byCountry?.[c.id];
      const levelsHere = entry ?? settings?.levels ?? [];
      const folder = groupOption(
        `country-${c.id}`,
        pickName(c.name, locale),
        [...(c.levels ?? [])]
          .sort((a, b) => a.position - b.position)
          .filter((l) => allowed("levels", l.position))
          .map((l) => ({ ...pick("levels", l.position, t("level", { n: l.position })), on: levelsHere.includes(l.position) })),
      );
      return byCountry ? { ...folder, countryId: c.id, custom: entry !== undefined } : folder;
    });

  // Departments nest by `parentKey`; a sub-department whose parent is not offered stands on its own.
  const offered = departments.filter(usable("departments"));
  const keys = new Set(offered.map((d) => d.key));
  const department = (d: CatalogItem): DataOption =>
    pick(
      "departments",
      d.key,
      pickName(d.name, locale),
      offered.filter((x) => x.parentKey === d.key).map(department),
    );
  const departmentOptions = offered.filter((d) => !d.parentKey || !keys.has(d.parentKey)).map(department);

  const byGroup = (g: string) => businessTypes.filter((b) => b.group === g);

  // A metal or token: offered when ACTIVE (a unit: when its parent holds it);
  // one a setting still names stays, greyed, whatever its status.
  const coins = (list: "metals" | "cryptoTokens", items: Coin[]): DataOption[] =>
    items
      .filter((i) => own(list).has(i.id) || ((i.status ?? "ACTIVE") === "ACTIVE" && allowed(list, i.id)))
      .map((i) => ({
        ...pick(list, i.id, [i.symbol, pickName(i.name, locale), i.network].filter(Boolean).join(" · ")),
        list,
        ...((i.status ?? "ACTIVE") !== "ACTIVE" ? { disabled: true } : {}),
      }));
  // Gold and Silver are one metal each (XAU, XAG): the row itself is the pick.
  const metalOption = (id: string, label: string, symbol: string): DataOption[] =>
    coins("metals", metals.filter((m) => m.symbol.toUpperCase() === symbol)).map((o) => ({ ...o, id: `${id}-${o.id}`, label }));
  const money = currencies
    .filter((c) => allowed("currencies", c.id))
    .map((c) => pick("currencies", c.id, pickName(c.name, locale)));

  const tabs: Record<DataTab, DataGroup[]> = {
    regions: [{ ...group("regions", t("groups.regions"), "regions/map", levelOptions, "levels"), ...(byCountry ? { byCountry: true } : {}) }],
    currencies: [
      group(
        "currencies",
        t("groups.currencies"),
        "nav/currencies",
        [
          groupOption("money", t("money"), money),
          ...(hasLists
            ? [
                groupOption(
                  "crypto",
                  t("crypto"),
                  coins("cryptoTokens", tokens),
                ),
                ...metalOption("gold", t("gold"), "XAU"),
                ...metalOption("silver", t("silver"), "XAG"),
              ]
            : [
                // Not saved until RDB lists crypto tokens and metals (guide 1.21 §5).
                opt(t("crypto"), false, [opt("USDT, TRON, TRC20", false), opt("ETH", false)]),
                opt(t("gold"), false),
                opt(t("silver"), false),
              ]),
        ],
        "currencies",
      ),
    ],
    structure: [
      group("departments", t("groups.departments"), "nav/hierarchy", departmentOptions, "departments"),
      group("levels", t("groups.adminLevels"), "business/work-type", catalog("adminLevels", adminLevels), "adminLevels"),
      group("titles", t("groups.jobTitles"), "business/individual", catalog("jobTitles", jobTitles), "jobTitles"),
    ],
    // The roles a level may give are the console's (§5.14a): built on the screen from `level-roles`.
    // The design's Permissions row is gone — what a role carries is set on the role itself.
    rbac: [],
    business: [
      group("work-types", t("groups.workTypes"), "business/corporate", catalog("workTypes", workTypes), "workTypes"),
      group(
        "business-types",
        t("groups.businessTypes"),
        "nav/business",
        [
          groupOption("individual", t("individual"), catalog("businessTypes", byGroup("individual"))),
          groupOption("corporate", t("corporate"), catalog("businessTypes", byGroup("corporate"))),
        ],
        "businessTypes",
      ),
      // The legal entities a level may use (Branch, Subsidiary, Representative):
      // RDB 1.21 accepts a country office's legal entity only if the head office
      // lists it here (decided 2026-11-23: under the business types).
      group("legal-entities", t("groups.legalEntities"), "work/legal", catalog("legalEntities", legalEntities), "legalEntities"),
    ],
  };
  return {
    tabs,
    settings,
    mayEdit,
    countryChoices: countries.flatMap((c) => (c.code ? [{ id: c.id, code: c.code.toUpperCase() }] : [])),
    workTypes: workTypes
      .filter((w) => (w.status ?? "ACTIVE") === "ACTIVE")
      .map((w) => ({ key: w.key, short: w.shortName ?? w.key.toUpperCase(), name: pickName(w.name, locale) })),
  };
}

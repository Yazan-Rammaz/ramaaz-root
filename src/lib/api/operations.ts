import "server-only";
import { cache } from "react";
import { z } from "zod";
import { backendFetch } from "./backend";

/**
 * THE one way to call a project's operation (RDB's currencies, countries,
 * regions, …). Server-only.
 *
 * Every project call goes through a single route on the root backend,
 * `POST /v1/projects/{id}/operations/{name}`, and the project declares which
 * names exist (`backend docs/project-data/from-backend/2026-10-30-rdb-screens.md` §2,
 * `console-api.md` §6). `backendFetch` already supplies the `/v1/projects/{id}`
 * prefix for the selected system; this file only knows the envelope.
 *
 * Two field-naming worlds meet here, on purpose: the envelope (`params`,
 * `query`, `body`, `reason`, `correlation_id`) is the console's snake_case, and
 * everything inside `params`, `body` and the returned `data` is the project's
 * own — camelCase for RDB — passed through unchanged.
 */

type ReadInput = {
  /** The path placeholders, keyed exactly as the operation writes them, case included. */
  params?: Record<string, string>;
  /** String values only; at most 50 entries. */
  query?: Record<string, string>;
};

type CommandInput = {
  params?: Record<string, string>;
  /** Sent to the project unchanged — only the fields it lists. */
  body?: Record<string, unknown>;
  /** Required on operations with `requires_reason`; never put it in `body`. */
  reason?: string;
};

const readEnvelope = z.object({ data: z.unknown() });

const commandEnvelope = z.object({
  /** `COMPLETED`, or `UNKNOWN`: nobody knows yet whether it happened. */
  status: z.string(),
  command: z.object({ id: z.string() }).loose(),
  data: z.unknown().optional(),
});

/**
 * What a command came to. `UNKNOWN` is never a failure — a timeout, a dropped
 * connection or the project still working — and is resolved only by retrying
 * the SAME command (`retryCommand`), which the project answers from its own
 * record instead of doing it twice.
 *
 * A command the project REFUSED is not here: it throws an `ApiError` like any
 * other refusal, carrying `details.command_id`.
 */
export type CommandOutcome =
  | { status: "COMPLETED"; commandId: string; data: unknown }
  | { status: "UNKNOWN"; commandId: string };

function toOutcome(raw: unknown): CommandOutcome {
  const env = commandEnvelope.parse(raw);
  return env.status === "COMPLETED"
    ? { status: "COMPLETED", commandId: env.command.id, data: env.data }
    : { status: "UNKNOWN", commandId: env.command.id };
}

const operationPath = (name: string) => `/operations/${encodeURIComponent(name)}`;

/** A read. Answers the project's own `data`, exactly as it sent it. */
export async function readOperation(name: string, input: ReadInput = {}): Promise<unknown> {
  const raw = await backendFetch.post<unknown>(operationPath(name), input);
  return readEnvelope.parse(raw).data;
}

/**
 * A command. One fresh `Idempotency-Key` per call — that is, per click: the
 * only legitimate reuse is a retry of the same action, and that goes through
 * `retryCommand` by the command's id, so the key never has to leave the server.
 */
export async function runCommand(name: string, input: CommandInput): Promise<CommandOutcome> {
  const raw = await backendFetch.post<unknown>(operationPath(name), input, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  return toOutcome(raw);
}

/**
 * Retry a command that came back `UNKNOWN`. Possible for 24 hours after it was
 * first sent; after that it is `412 COMMAND_RETRY_EXPIRED` and the person has
 * to check in the project whether it happened.
 */
export async function retryCommand(commandId: string): Promise<CommandOutcome> {
  const raw = await backendFetch.post<unknown>(
    `/commands/${encodeURIComponent(commandId)}/retry`,
  );
  return toOutcome(raw);
}

/**
 * Run `name`, or — when the previous press of the same button came back
 * `UNKNOWN` — retry that command instead of sending a second one. Every
 * Server Action that writes takes the pending id from its client for this.
 */
export function commandOrRetry(
  name: string,
  input: CommandInput,
  pendingCommandId?: string,
): Promise<CommandOutcome> {
  return pendingCommandId ? retryCommand(pendingCommandId) : runCommand(name, input);
}

const operationsSchema = z.object({
  data: z.array(
    z.object({ name: z.string(), status: z.string(), path: z.string().optional() }).loose(),
  ),
});

/**
 * Every operation the selected project declares, by name — memoised for one
 * request, since a screen asks both "is it on?" and "what is its placeholder
 * called?". Keyed on nothing: the selection cannot change inside a request
 * without a new one.
 */
const operationCatalog = cache(async () => {
  const { data } = operationsSchema.parse(await backendFetch.get<unknown>("/operations"));
  return new Map(data.map((o) => [o.name, o]));
});

/**
 * The names of the operations the selected project offers right now
 * (`GET /v1/projects/{id}/operations`, `status: "ACTIVE"` only). A screen
 * shows a button for an operation only once it is here — which is how a
 * feature switches itself on when the project deploys it.
 */
export async function activeOperations(): Promise<Set<string>> {
  const catalog = await operationCatalog();
  return new Set([...catalog.values()].filter((o) => o.status === "ACTIVE").map((o) => o.name));
}

/**
 * `params` for an operation with one placeholder in its path, keyed exactly as
 * the project wrote it (`/languages/{code}` → `{ code }`) — the console
 * refuses a missing or misspelt one with `422`. Read from the operation list
 * rather than assumed, because the notes give the body of an operation but
 * not its path. `fallback` names it when the list has no path to read.
 */
export async function oneParam(
  operation: string,
  value: string,
  fallback: string,
): Promise<Record<string, string>> {
  const path = (await operationCatalog().catch(() => null))?.get(operation)?.path ?? "";
  const placeholder = path.match(/\{([^}]+)\}/)?.[1] ?? fallback;
  return { [placeholder]: value };
}

const pageSchema = z.object({
  items: z.array(z.unknown()),
  pagination: z.object({ hasNext: z.boolean() }).loose(),
});

/**
 * Every item of a paged list (`{ items, pagination }`, `page` from 0). The
 * project caps `limit` at 100; the console's own screens list everything, so
 * this walks the pages. `maxPages` is a ceiling against a project that never
 * says it is done, not a feature.
 */
export async function readAllPages(
  name: string,
  input: ReadInput = {},
  maxPages = 50,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = pageSchema.parse(
      await readOperation(name, {
        ...input,
        query: { ...input.query, page: String(page), limit: "100" },
      }),
    );
    items.push(...data.items);
    if (!data.pagination.hasNext) break;
  }
  return items;
}

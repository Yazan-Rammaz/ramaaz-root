import { z } from "zod";

/**
 * A system project (the rows under "System Projects"). Line 1 is `code`, line 2
 * `name`, line 3 `description` (console-api.md §5.1).
 */
export const systemSchema = z.object({
  id: z.string(),
  code: z.string(), // e.g. "rdb"
  name: z.string(), // e.g. "Ramaaz Digital Banking"
  description: z.string(), // e.g. "Payment Services Provider"
  /** `DRAFT | ACTIVE | SUSPENDED`. */
  status: z.string().optional(),
  /** `NOT_CONNECTED | CONNECTED | FAILED`. */
  connectionStatus: z.string().optional(),
  /** Only while FAILED: the backend's code (see `CONNECTION_ERRORS`) and its message. */
  connectionError: z.object({ code: z.string(), message: z.string().optional() }).optional(),
  /** False → greyed out; a card that isn't selectable opens "connect" instead. */
  selectable: z.boolean(),
});

export type System = z.infer<typeof systemSchema>;

/**
 * Step 1 of adding a project. The same rules the backend enforces (§5.2), so a
 * mistake is caught before the round trip. The backend still checks every one.
 */
export const createProjectSchema = z.object({
  /** 2–20 lowercase letters, digits and `-`, not starting or ending with `-`. */
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])$/),
  name: z.string().trim().min(1).max(100),
  /** Optional: an empty field is sent as absent, never as "". */
  name_ar: z
    .string()
    .trim()
    .max(100)
    .transform((v) => v || undefined),
  description: z.string().trim().min(1).max(150),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/** Step 2: where the project's backend lives. https only (the backend adds the rest). */
export const connectProjectSchema = z.object({
  base_url: z
    .string()
    .trim()
    .url()
    .refine((v) => v.startsWith("https://")),
});

/**
 * The `connection_error.code` values the backend names (§5.3), each with its
 * own message key under `system.connection.errors`. Anything else falls back to
 * the backend's own message.
 */
export const CONNECTION_ERRORS = [
  "PROJECT_UNREACHABLE",
  "PROJECT_REJECTED_TOKEN",
  "PROJECT_CODE_MISMATCH",
  "PROJECT_BAD_MANIFEST",
  "PROJECT_CONTRACT_UNSUPPORTED",
  "PROJECT_ERROR",
  "BASE_URL_NOT_ALLOWED",
] as const;

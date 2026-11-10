import "server-only";
import type { z } from "zod";
import { cfEnv } from "@/lib/cf-env";

/**
 * THE one way to ask the AI for structured data. Server-only — no key ever
 * reaches the browser.
 *
 * Any OpenAI-compatible Chat Completions endpoint, with a strict JSON schema
 * so the answer is data, not prose; it is then parsed with the caller's zod
 * schema like any backend answer, and anything that does not fit is thrown
 * away.
 *
 * ── Where it calls today: Workers AI, through our Cloudflare AI Gateway ─────
 * OpenAI itself refuses calls from Syria (`403
 * unsupported_country_region_territory`), and a relay does not help: OpenAI
 * sits behind Cloudflare, which tells it where the request started. Workers AI
 * is Cloudflare's own model hosting, so no such block applies. `ramaaz` on the
 * Yazan.adnof account is an Authenticated Gateway; one Cloudflare API token
 * (Account · AI Gateway · Run) both opens the gateway and is the Workers AI
 * key.
 *
 * Config (Cloudflare secret/var, `.dev.vars` or `.env.local`):
 *   AI_BASE_URL       the endpoint, up to `/chat/completions`. Default: OpenAI.
 *                     Workers AI via the gateway:
 *                     https://gateway.ai.cloudflare.com/v1/{account}/ramaaz/workers-ai/v1
 *   AI_MODEL          default DEFAULT_MODEL (OpenAI's). Workers AI: @cf/openai/gpt-oss-120b
 *   AI_API_KEY        the provider's key. Unset = AI_GATEWAY_TOKEN, which is
 *                     the key for Workers AI too.
 *   AI_GATEWAY_TOKEN  the gateway's token, sent as `cf-aig-authorization`. Secret.
 *   AI_REASONING_EFFORT  for a reasoning model (gpt-oss): `low` keeps it to a
 *                     few seconds. Leave unset for a model without reasoning —
 *                     OpenAI rejects the field there.
 * Neither key set = no AI — not an error.
 *
 * ⚠️ It NEVER throws. No key, a timeout, a refusal, a malformed answer — all
 * are `null`, and every caller has an empty fallback the person fills in by
 * hand. The AI only saves typing; nothing depends on it being there.
 */

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 20_000;
/** Room for a reasoning model's thinking AND the answer — it cut off at the default. */
const MAX_TOKENS = 3000;

export function isAiConfigured(): boolean {
  return Boolean(cfEnv("AI_API_KEY") ?? cfEnv("AI_GATEWAY_TOKEN"));
}

export async function generateJson<T>({
  name,
  schema,
  jsonSchema,
  system,
  prompt,
}: {
  /** A short id for the schema (letters, digits, `_`), and the log line. */
  name: string;
  /** Parses the answer — the same boundary as every backend response. */
  schema: z.ZodType<T>;
  /** The same shape as JSON Schema, in OpenAI's strict subset (every key required, no extras). */
  jsonSchema: Record<string, unknown>;
  system: string;
  prompt: string;
}): Promise<T | null> {
  const gatewayToken = cfEnv("AI_GATEWAY_TOKEN");
  const key = cfEnv("AI_API_KEY") ?? gatewayToken;
  if (!key) {
    console.warn(`[ai] ${name}: no AI_API_KEY or AI_GATEWAY_TOKEN — fields come back empty`);
    return null;
  }
  const base = (cfEnv("AI_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const reasoningEffort = cfEnv("AI_REASONING_EFFORT");

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(gatewayToken && { "cf-aig-authorization": `Bearer ${gatewayToken}` }),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: cfEnv("AI_MODEL") ?? DEFAULT_MODEL,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
        messages: [
          // The schema goes in the instructions as well: OpenAI shows the model
          // each field's `description`, Workers AI only uses the schema to
          // shape the output — without this it filled `plate` with "province".
          {
            role: "system",
            content:
              `${system}\n\nAnswer with one JSON object matching this JSON Schema; ` +
              `each field's "description" says what goes in it:\n${JSON.stringify(jsonSchema)}`,
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema: jsonSchema },
        },
      }),
    });
    if (!res.ok) {
      // The provider's own reason — e.g. OpenAI's `unsupported_country_region_territory`,
      // or a Workers AI / gateway message.
      const reason = await res
        .json()
        .then(
          (b: { error?: { code?: string } | { message?: string }[]; message?: string }) =>
            (Array.isArray(b.error) ? b.error[0]?.message : b.error?.code) ?? b.message,
        )
        .catch(() => undefined);
      console.warn(`[ai] ${name}: HTTP ${res.status}${reason ? ` ${reason}` : ""}`);
      return null;
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null; refusal?: string | null } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(`[ai] ${name}: no content${body.choices?.[0]?.message?.refusal ? " (refused)" : ""}`);
      return null;
    }
    const parsed = schema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      console.warn(`[ai] ${name}: answer did not fit the schema`);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.warn(`[ai] ${name}: ${error instanceof Error ? error.name : "failed"}`);
    return null;
  }
}

/**
 * System One model catalog (`GET /v1/systemone/models`).
 *
 * OpenRouter publishes its decision (System One) models on the public models
 * API filtered by `output_modalities=decisions`; no upstream credential is
 * needed. The list is fetched live on every call so it follows provider
 * changes, validated at the trust boundary, and re-emitted as an OpenAI-style
 * `{ object: "list", data }` with the upstream ids, names, architecture and
 * pricing untouched.
 */

import { z } from "zod";
import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { sanitizeErrorMessage } from "../utils/errorSanitization.ts";
import * as log from "@/sse/utils/logger";

export const SYSTEMONE_MODELS_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=decisions";
export const SYSTEMONE_MODELS_TIMEOUT_MS = 10_000;
// The real decisions list is a few tens of KB; anything this large is not it.
const MAX_BODY_CHARS = 2_000_000;
const DECISIONS_MODALITY = "decisions";

const upstreamModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canonical_slug: z.string().optional(),
  created: z.number().optional(),
  description: z.string().optional(),
  context_length: z.number().nullable().optional(),
  architecture: z.object({
    modality: z.string().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()),
    tokenizer: z.string().optional(),
    instruct_type: z.string().nullable().optional(),
  }),
  pricing: z.record(z.string(), z.string()),
  top_provider: z
    .object({
      context_length: z.number().nullable().optional(),
      max_completion_tokens: z.number().nullable().optional(),
      is_moderated: z.boolean().optional(),
    })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
});

const upstreamListSchema = z.object({ data: z.array(z.unknown()) });

export type SystemOneModel = z.infer<typeof upstreamModelSchema> & {
  object: "model";
  owned_by: string;
};

export interface SystemOneModelsOptions {
  /** Per-model API-key policy filter; receives the upstream model id. */
  isModelAllowed?: (modelId: string) => Promise<boolean>;
}

function toDecisionModel(raw: unknown): SystemOneModel | null {
  const parsed = upstreamModelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const model = parsed.data;
  if (!model.architecture.output_modalities.includes(DECISIONS_MODALITY)) return null;
  const provider = model.id.replace(/^~/, "").split("/")[0] || "openrouter";
  return { object: "model", owned_by: provider, ...model };
}

function upstreamFailure(reason: string, status = 502): Response {
  log.warn("SYSTEMONE", `models upstream failed: ${reason}`);
  return errorResponse(status, "System One models are temporarily unavailable");
}

export async function handleSystemOneModels(
  options: SystemOneModelsOptions = {}
): Promise<Response> {
  let text: string;
  try {
    const res = await fetch(SYSTEMONE_MODELS_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SYSTEMONE_MODELS_TIMEOUT_MS),
    });
    if (!res.ok) return upstreamFailure(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return upstreamFailure("timeout", 504);
    }
    return upstreamFailure(sanitizeErrorMessage(err instanceof Error ? err.message : String(err)));
  }
  if (text.length > MAX_BODY_CHARS) return upstreamFailure("body too large");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return upstreamFailure("invalid JSON");
  }
  const list = upstreamListSchema.safeParse(json);
  if (!list.success) return upstreamFailure("unexpected list shape");

  const models = list.data.data
    .map(toDecisionModel)
    .filter((model): model is SystemOneModel => model !== null);
  // A non-empty upstream list with no valid decisions model means the filter or
  // the schema drifted; fail closed rather than present an empty catalog.
  if (list.data.data.length > 0 && models.length === 0) {
    return upstreamFailure("no valid decisions models");
  }

  const allowed: SystemOneModel[] = [];
  for (const model of models) {
    if (!options.isModelAllowed || (await options.isModelAllowed(model.id))) allowed.push(model);
  }

  return new Response(JSON.stringify({ object: "list", data: allowed }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

import {
  canonicalSystemOneModel,
  SYSTEMONE_PROVIDER_ID,
} from "@omniroute/open-sse/handlers/systemOne.ts";
import { handleSystemOneModels } from "@omniroute/open-sse/handlers/systemOneModels.ts";
import { enforceApiKeyPolicy, validateApiKeyRoutingTarget } from "@/shared/utils/apiKeyPolicy";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/systemone/models — live catalog of System One (decisions) models.
 *
 * Fetched from OpenRouter's public models API (no credential). The API key's
 * endpoint category, budget and rate limits apply as for POST /v1/systemone,
 * and its model allow/deny rules narrow the list with the same canonical
 * `openrouter/<id>` target the POST route enforces.
 */
export async function GET(request: Request) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const { apiKey, apiKeyInfo } = policy;
  return handleSystemOneModels({
    isModelAllowed: async (modelId) =>
      (await validateApiKeyRoutingTarget(
        request,
        apiKey,
        apiKeyInfo,
        `${SYSTEMONE_PROVIDER_ID}/${canonicalSystemOneModel(modelId)}`
      )) === null,
  });
}

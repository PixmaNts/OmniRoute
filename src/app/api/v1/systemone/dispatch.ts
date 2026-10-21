import {
  handleSystemOneProxy,
  type SystemOneCredentials,
} from "@omniroute/open-sse/handlers/systemOne.ts";
import { resolveSystemOneTarget } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import { validateSystemOneBackendBody } from "@omniroute/open-sse/handlers/systemOneValidation.ts";
import { resolveLocalSyncedEndpointRoute } from "@/lib/providerModels/syncedEndpointRouting";
import { getSyncedAvailableModelsForConnection } from "@/lib/db/models";
import { getProviderConnections } from "@/lib/db/providers";
import { getModelLockoutInfo } from "@omniroute/open-sse/services/accountFallback.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";

type Target = ReturnType<typeof resolveSystemOneTarget>;

/**
 * A row whose `systemone` endpoint came from Ollama's /api/show carries that host's full
 * capability list, so a missing `supportsVision` there means text-only. A model routed only
 * by an operator override has no capability evidence and is left to the upstream.
 */
async function acceptsImages(provider: string, connectionId: string, model: string) {
  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  const row = rows.find((candidate) => candidate.id === model);
  return !row?.supportedEndpoints?.includes("systemone") || row.supportsVision === true;
}

/** Narrow the key's connection allowlist to Ollama hosts whose live catalog has the model. */
async function resolveAllowedConnections(
  target: Target,
  keyConnections: string[] | undefined,
  hasImages: boolean
): Promise<{ ids: string[] | null } | { error: Response }> {
  const allowed = keyConnections?.length ? keyConnections : null;
  if (target.provider !== "ollama-local") return { ids: allowed };
  const route = await resolveLocalSyncedEndpointRoute(target.canonicalModel, "systemone");
  if (!route) return { ids: allowed };
  const eligible = route.connectionIds.filter((id) => !allowed || allowed.includes(id));
  if (!eligible.length) {
    return { error: errorResponse(403, "No allowed Ollama connection has this decision model") };
  }
  if (!hasImages) return { ids: eligible };
  const withVision: string[] = [];
  for (const id of eligible) {
    if (await acceptsImages(route.provider, id, route.model)) withVision.push(id);
  }
  if (!withVision.length) {
    return { error: errorResponse(400, `Model ${target.canonicalModel} does not accept images`) };
  }
  return { ids: withVision };
}

/**
 * The selector returns no credentials both when the backend has no usable connection and
 * when every connection locked this one model after the upstream said it does not have it
 * (Ollama 404 model_not_found). The second case is not a credentials problem: answer 404
 * so the caller pulls the model instead of re-checking its keys. Retryable lockouts never
 * get here, they come back as all-rate-limited (429).
 */
async function lockedModelResponse(
  provider: string,
  model: string,
  allowed: string[] | null
): Promise<Response | null> {
  const active = (await getProviderConnections({ provider, isActive: true })).filter(
    (row: { id: string }) => !allowed || allowed.includes(row.id)
  );
  if (!active.length) return null;
  const locked = active.every((row: { id: string }) =>
    Boolean(getModelLockoutInfo(provider, row.id, model))
  );
  if (!locked) return null;
  return errorResponse(
    HTTP_STATUS.NOT_FOUND,
    `Model ${model} is not available on ${provider}: the upstream reported it missing`
  );
}

export async function dispatchSystemOneTarget(args: {
  body: Record<string, unknown> & { model: string };
  model: string;
  signal: AbortSignal;
  apiKeyInfo: Awaited<ReturnType<typeof enforceApiKeyPolicy>>["apiKeyInfo"];
  connectionId?: string | null;
}): Promise<Response> {
  if (args.signal.aborted) return errorResponse(499, "System One request aborted by caller");
  let target: Target;
  try {
    target = resolveSystemOneTarget(args.model);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "Invalid System One target");
  }
  const backend = validateSystemOneBackendBody(target.provider, args.body);
  if (backend.ok === false) return errorResponse(backend.status, backend.message);
  const connections = await resolveAllowedConnections(
    target,
    args.apiKeyInfo?.allowedConnections,
    Array.isArray(args.body.images) && args.body.images.length > 0
  );
  if ("error" in connections) return connections.error;
  if (args.connectionId && connections.ids && !connections.ids.includes(args.connectionId))
    return errorResponse(403, "Combo account is outside the API key connection allowlist");
  const allowed = args.connectionId ? [args.connectionId] : connections.ids;
  const canonicalModel = target.model.replace(/^~/, "");
  const credentials = await getProviderCredentialsWithQuotaPreflight(
    target.provider,
    null,
    allowed,
    canonicalModel
  );
  if (!credentials)
    return (
      (await lockedModelResponse(target.provider, canonicalModel, allowed)) ??
      errorResponse(400, `No credentials for provider: ${target.provider}`)
    );
  if (isAllRateLimitedCredentials(credentials))
    return rateLimitedProviderResponse(target.provider, credentials);
  const response = await handleSystemOneProxy({
    body: { ...args.body, model: target.model },
    provider: target.provider,
    requestedModel: args.body.model,
    signal: args.signal,
    credentials: credentials as SystemOneCredentials,
    canonicalModel,
    apiKeyInfo: args.apiKeyInfo,
  });
  if (response.ok) await clearRecoveredProviderState(credentials);
  return response;
}

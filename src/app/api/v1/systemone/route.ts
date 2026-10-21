import { handleComboChat } from "@omniroute/open-sse/services/combo.ts";
import { resolveSystemOneTarget } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1SystemOneSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { getComboByName, getCombos } from "@/lib/db/combos";
import { getCachedSettings } from "@/lib/db/readCache";
import * as log from "@/sse/utils/logger";
import { dispatchSystemOneTarget } from "./dispatch";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** Serve decision models directly or through a fill-first/priority combo. */
async function postHandler(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const validated = validateBody(v1SystemOneSchema, raw);
  if (isValidationFailure(validated)) return errorResponse(400, validated.error.message);
  const body = validated.data;
  const combo = await getComboByName(body.model);
  let canonical = body.model;
  if (!combo) {
    try {
      canonical = resolveSystemOneTarget(body.model).canonicalModel;
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error ? error.message : "Invalid System One target"
      );
    }
  }
  const policy = await enforceApiKeyPolicy(request, canonical);
  if (policy.rejection) return policy.rejection;
  if (!combo)
    return dispatchSystemOneTarget({
      body,
      model: body.model,
      signal: request.signal,
      apiKeyInfo: policy.apiKeyInfo,
    });
  if (!["fill-first", "priority"].includes(combo.strategy ?? "priority"))
    return errorResponse(400, "System One combos support fill-first or priority");
  return handleComboChat({
    body: { ...body, stream: false },
    combo,
    allCombos: await getCombos(),
    settings: await getCachedSettings(),
    log,
    signal: request.signal,
    apiKeyAllowedConnections: policy.apiKeyInfo?.allowedConnections ?? null,
    handleSingleModel: async (_attempt, model, target) =>
      dispatchSystemOneTarget({
        body,
        model,
        signal: target?.modelAbortSignal ?? request.signal,
        apiKeyInfo: policy.apiKeyInfo,
        connectionId: target?.connectionId,
      }),
  });
}

export const POST = withInjectionGuard(postHandler);

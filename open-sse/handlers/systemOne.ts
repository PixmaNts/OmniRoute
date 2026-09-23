/**
 * System One proxy (TypeSafe Jev and future System One models).
 *
 * System One models do not generate text: the client sends `state` plus typed
 * `questions` (noul / choice / score) and gets typed answers with
 * probabilities. OpenRouter serves them at `/api/v1/systemone` with the
 * TypeSafe request/response shape, maps bare ids (`jev-latest`) onto its
 * `typesafe/` namespace, and reports the exact USD cost in `usage.cost`.
 * See https://openrouter.ai/docs/guides/community/typesafe-sdk.
 */

import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog, saveRequestUsage } from "@/lib/usageDb";
import { recordCost } from "@/domain/costRules";
import { markAccountUnavailable } from "../../src/sse/services/auth.ts";

export const SYSTEMONE_PROVIDER_ID = "openrouter";
export const SYSTEMONE_UPSTREAM_URL = "https://openrouter.ai/api/v1/systemone";

export interface SystemOneCredentials {
  apiKey?: string | null;
  accessToken?: string | null;
  connectionId?: string | null;
}

export interface SystemOneProxyOptions {
  body: Record<string, unknown>;
  credentials: SystemOneCredentials | null;
  /** `typesafe/<id>` form used for API-key policy, cooldown and cost attribution. */
  canonicalModel?: string | null;
  apiKeyInfo?: { id?: string | null; name?: string | null } | null;
}

/**
 * Bare TypeSafe ids (`jev-latest`) and OpenRouter's alias spelling
 * (`~typesafe/jev-latest`) name the same model upstream; normalize both to
 * `typesafe/<id>` so one allow/deny rule covers every spelling.
 */
export function canonicalSystemOneModel(model: string): string {
  const trimmed = model.trim().replace(/^~/, "");
  return trimmed.includes("/") ? trimmed : `typesafe/${trimmed}`;
}

// 422 is a request-shape error from the caller, not a fault of the connection.
function shouldCoolDownConnection(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

type SystemOneUpstreamBody = {
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  message?: string;
  error?: { message?: string } | string;
};

export async function handleSystemOneProxy(options: SystemOneProxyOptions): Promise<Response> {
  const startTime = Date.now();
  const token = options.credentials?.apiKey || options.credentials?.accessToken;
  const connectionId = options.credentials?.connectionId || null;
  const requestedModel = typeof options.body.model === "string" ? options.body.model : null;
  const canonicalModel =
    options.canonicalModel || (requestedModel ? canonicalSystemOneModel(requestedModel) : null);
  const apiKeyId = options.apiKeyInfo?.id || null;

  if (!token) {
    return errorResponse(401, `No credentials for provider: ${SYSTEMONE_PROVIDER_ID}`);
  }

  try {
    const res = await fetch(SYSTEMONE_UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(options.body),
    });

    const text = await res.text();
    let parsed: SystemOneUpstreamBody | null = null;
    try {
      parsed = text ? (JSON.parse(text) as SystemOneUpstreamBody) : null;
    } catch {
      parsed = null;
    }

    if (res.ok && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      return errorResponse(502, "System One upstream returned an invalid response body");
    }

    const model = parsed?.model || requestedModel || "systemone";
    const inputTokens = Number(parsed?.usage?.input_tokens) || 0;
    const outputTokens = Number(parsed?.usage?.output_tokens) || 0;
    const costUsd = res.ok ? Number(parsed?.usage?.cost) || 0 : 0;
    const errorMessage = res.ok
      ? null
      : parsed?.message ||
        (typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message) ||
        `Provider returned HTTP ${res.status}`;

    saveCallLog({
      method: "POST",
      path: "/v1/systemone",
      status: res.status,
      model,
      requestedModel,
      provider: SYSTEMONE_PROVIDER_ID,
      duration: Date.now() - startTime,
      tokens: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      connectionId,
      requestType: "systemone",
      apiKeyId: apiKeyId || undefined,
      apiKeyName: options.apiKeyInfo?.name || undefined,
      ...(errorMessage ? { error: errorMessage } : {}),
    }).catch(() => {});

    if (!res.ok) {
      if (connectionId && shouldCoolDownConnection(res.status)) {
        try {
          await markAccountUnavailable(
            connectionId,
            res.status,
            errorMessage,
            SYSTEMONE_PROVIDER_ID,
            canonicalModel,
            null,
            { headers: res.headers }
          );
        } catch {
          // The upstream response has priority over a best-effort cooldown write.
        }
      }
      const response = errorResponse(res.status, errorMessage);
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) response.headers.set("retry-after", retryAfter);
      return response;
    }

    saveRequestUsage({
      provider: SYSTEMONE_PROVIDER_ID,
      model,
      tokens: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      status: "200",
      success: true,
      latencyMs: Date.now() - startTime,
      connectionId: connectionId || undefined,
      apiKeyId: apiKeyId || undefined,
      apiKeyName: options.apiKeyInfo?.name || undefined,
      endpoint: "/v1/systemone",
    }).catch(() => {});

    if (apiKeyId && costUsd > 0) {
      recordCost(apiKeyId, costUsd, {
        provider: SYSTEMONE_PROVIDER_ID,
        model,
        tokens: { input: inputTokens, output: outputTokens },
        success: true,
      });
    }

    const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
    attachOmniRouteMetaHeaders(headers, {
      provider: SYSTEMONE_PROVIDER_ID,
      model,
      costUsd,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
    });
    return new Response(text, { status: 200, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `System One request failed: ${message}`);
  }
}

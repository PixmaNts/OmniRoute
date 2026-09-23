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
import { saveCallLog } from "@/lib/usageDb";

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
      ...(errorMessage ? { error: errorMessage } : {}),
    }).catch(() => {});

    if (!res.ok) {
      const response = errorResponse(res.status, errorMessage);
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) response.headers.set("retry-after", retryAfter);
      return response;
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

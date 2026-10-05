import { SYSTEMONE_BACKENDS } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import { parseTypeSafeModels } from "@omniroute/open-sse/handlers/systemOneCatalog.ts";
import { buildBearerHeaders } from "./headers";
import { toValidationErrorResult, validationRead } from "./transport";

/** Credential validation is an authenticated catalog read, never paid inference. */
export async function validateTypeSafeProvider({
  apiKey,
  providerSpecificData = {},
  fetchImpl = validationRead,
}: {
  apiKey: string;
  providerSpecificData?: Record<string, unknown>;
  fetchImpl?: typeof validationRead;
}) {
  try {
    const url = SYSTEMONE_BACKENDS.typesafe.modelsUrl;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: buildBearerHeaders(apiKey, providerSpecificData),
    });
    if (response.ok) {
      parseTypeSafeModels(await response.json());
      return { valid: true, error: null, method: "typesafe_models", testedEndpoint: `GET ${url}` };
    }
    return {
      valid: false,
      error: `TypeSafe catalog validation returned HTTP ${response.status}`,
      method: "typesafe_models",
      testedEndpoint: `GET ${url}`,
    };
  } catch (error) {
    return toValidationErrorResult(error);
  }
}

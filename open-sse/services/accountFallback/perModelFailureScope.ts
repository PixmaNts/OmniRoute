/**
 * accountFallback/perModelFailureScope.ts — whether a NON-QUOTA failure should lock
 * one model instead of cooling the whole connection.
 *
 * Extracted from services/accountFallback.ts (file-size gate, #12334). A Claude
 * OAuth connection multiplexes Fable 5, Opus, Sonnet and Haiku behind one
 * credential, so a 404/5xx names one model. Quota is a separate question:
 * hasPerModelQuota("claude") is false and a 429 stays account-wide.
 */
import { resolveProviderId } from "../../../src/shared/constants/providers";
import { hasPerModelQuota } from "../accountFallback.ts";

/**
 * @param status - When 429, only per-model *quota* providers qualify. Omit for
 *   the non-quota question (404/5xx), which also includes Claude.
 */
export function hasPerModelFailureScope(
  provider: string | null | undefined,
  model: string | null | undefined = null,
  connectionPassthroughModels?: boolean,
  status?: number
): boolean {
  if (status === 429) return hasPerModelQuota(provider, model, connectionPassthroughModels);
  if (hasPerModelQuota(provider, model, connectionPassthroughModels)) return true;
  if (typeof connectionPassthroughModels === "boolean") return connectionPassthroughModels;
  if (!provider) return false;
  const canonical = resolveProviderId(provider);
  // One TypeSafe key serves every Jev release, so a 404 names a mistyped or retired model
  // id, not the key. TypeSafe is not a passthrough gateway (it cannot route arbitrary
  // models), and its 429/5xx stay account-wide.
  if (status === 404 && canonical === "typesafe") return true;
  return canonical === "claude";
}

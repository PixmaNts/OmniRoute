import { hasUnsafeModelIdSyntax } from "../utils/modelIdSafety.ts";

/** Concrete System One transports; credentials remain in the normal provider store. */
export const SYSTEMONE_BACKENDS = {
  "opencode-systemone": {
    url: "https://opencode.ai/inference/systemone/v1/systemone",
    modelsUrl: null,
    requiresKey: false,
    timeoutMs: 8_000,
  },
  "command-code": {
    url: "https://api.commandcode.ai/provider/v1/systemone",
    modelsUrl: "https://api.commandcode.ai/provider/v1/models",
    requiresKey: true,
    timeoutMs: 20_000,
  },
  typesafe: {
    url: "https://api.typesafe.ai/v1/systemone",
    modelsUrl: "https://api.typesafe.ai/v1/models",
    requiresKey: true,
    timeoutMs: 30_000,
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/systemone",
    modelsUrl: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
    requiresKey: true,
    timeoutMs: 30_000,
  },
  "ollama-local": {
    url: "http://localhost:11434/v1/systemone",
    modelsUrl: null,
    requiresKey: false,
    timeoutMs: 60_000,
  },
} as const;

export type SystemOneProvider = keyof typeof SYSTEMONE_BACKENDS;
export type SystemOneTarget = {
  provider: SystemOneProvider;
  model: string;
  canonicalModel: string;
};

export function isSystemOneProvider(value: string): value is SystemOneProvider {
  return Object.prototype.hasOwnProperty.call(SYSTEMONE_BACKENDS, value);
}

/**
 * Published Jev rates in USD per 1M tokens. Output is free. The native catalogs carry no
 * pricing, so this is the only copy: the catalog row and the cost estimate both read it,
 * and an operator pricing row wins.
 *
 * TypeSafe checked 2026-10-05 ($0.042). CommandCode checked 2026-10-21 ($0.04,
 * https://commandcode.ai/models/jev).
 */
const TYPESAFE_JEV_PRICING = { input: 0.042, output: 0 } as const;
const COMMAND_CODE_JEV_PRICING = { input: 0.04, output: 0 } as const;

/** CommandCode serves pinned Jev releases as `typesafe/jev` and `typesafe/jev-<version>`. */
export function isCommandCodeJevModel(model: string): boolean {
  return /^typesafe\/jev(?:-|$)/.test(model);
}

export function nativeSystemOnePricing(
  provider: string,
  model: string
): { input: number; output: number } | null {
  if (provider === "opencode-systemone" && model === "jev-1.13-free")
    return { input: 0, output: 0 };
  if (provider === "command-code" && isCommandCodeJevModel(model))
    return { ...COMMAND_CODE_JEV_PRICING };
  return provider === "typesafe" && /^jev-/.test(model) ? { ...TYPESAFE_JEV_PRICING } : null;
}

export function resolveSystemOneTarget(value: string): SystemOneTarget {
  const id = value.trim();
  if (!id || hasUnsafeModelIdSyntax(id)) throw new Error("Invalid System One model ID");
  // `~vendor/model` is OpenRouter's own alias spelling, never a provider prefix.
  if (id.startsWith("~")) {
    if (!/^~[^/]+\/[^/]/.test(id)) throw new Error("Invalid System One model ID");
    return { provider: "openrouter", model: id, canonicalModel: `openrouter/${id.slice(1)}` };
  }
  const separator = id.indexOf("/");
  const prefix = separator < 0 ? "openrouter" : id.slice(0, separator);
  if (!isSystemOneProvider(prefix)) {
    throw new Error(
      `Provider ${prefix} does not support System One. For an OpenRouter model use openrouter/${id}`
    );
  }
  const model = separator < 0 ? `typesafe/${id}` : id.slice(separator + 1);
  if (!model) throw new Error("System One model is required after the provider prefix");
  return { provider: prefix, model, canonicalModel: `${prefix}/${model.replace(/^~/, "")}` };
}

/** These gateways serve decision models outside their chat /models inventory. */
export function staticSystemOneModels(provider: SystemOneProvider): Record<string, unknown>[] {
  const models =
    provider === "opencode-systemone"
      ? ["jev-1.13-free"]
      : provider === "command-code"
        ? ["typesafe/jev", "typesafe/jev-1.14.0"]
        : [];
  return models.map((id) => {
    const pricing = nativeSystemOnePricing(provider, id)!;
    return {
      id,
      name: id,
      context_length: 32000,
      supportedEndpoints: ["systemone"],
      apiFormat: "systemone",
      modelType: "decision",
      architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
      pricing: {
        prompt: String(pricing.input / 1_000_000),
        completion: String(pricing.output / 1_000_000),
      },
      pricing_source: provider === "opencode-systemone" ? "opencode-free" : "commandcode-published",
    };
  });
}

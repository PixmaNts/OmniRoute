import type { RegistryEntry } from "../../shared.ts";
import { SYSTEMONE_BACKENDS } from "../../../systemOneRegistry.ts";

export const opencodeSystemOneProvider: RegistryEntry = {
  id: "opencode-systemone",
  alias: "opencode-systemone",
  format: "systemone",
  executor: "none",
  baseUrl: SYSTEMONE_BACKENDS["opencode-systemone"].url,
  authType: "none",
  authHeader: "",
  models: [
    {
      id: "jev-1.13-free",
      name: "Jev 1.13 (OpenCode Free)",
      targetFormat: "systemone",
      contextLength: 32000,
    },
  ],
};

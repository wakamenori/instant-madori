import type { Ai } from "./round-trip.ts";
import { scriptedAi } from "./scripted.ts";
import { developmentScript } from "./scripts.ts";

const noProviderAi: Ai = {
  model: "none",
  roundTrip: () =>
    Promise.resolve({
      kind: "failed",
      reason: "no_provider",
      detail: "no AI provider is connected in this environment",
    }),
};

export function selectAi(settings: { readonly ENVIRONMENT: string }): Ai {
  return settings.ENVIRONMENT === "local" || settings.ENVIRONMENT === "staging"
    ? scriptedAi(developmentScript)
    : noProviderAi;
}

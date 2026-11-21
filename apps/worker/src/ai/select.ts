import type { Ai } from "./round-trip.ts";
import { scriptedAi } from "./scripted.ts";
import type { ScriptStep } from "./scripted.ts";

const developmentScript: readonly ScriptStep[] = [
  { stop: "end", parts: [{ kind: "text", text: "台本のAIの応答です。案は変えていません。" }] },
];

const noProviderAi: Ai = {
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

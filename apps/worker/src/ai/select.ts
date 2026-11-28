import { z } from "zod";
import { limits } from "../limits.ts";
import { anthropicAi } from "./anthropic.ts";
import type { Ai } from "./round-trip.ts";
import { scriptedAi } from "./scripted.ts";
import { developmentScript } from "./scripts.ts";

export interface AiRoster {
  forNewJob(isSmokeVerifier: () => Promise<boolean>): Promise<Ai>;
  continuing(model: string): Ai;
}

const noProviderAi: Ai = {
  model: "none",
  roundTrip: () =>
    Promise.resolve({
      kind: "failed",
      reason: "no_provider",
      detail: "no AI provider is connected in this environment",
    }),
};

const environmentSchema = z.object({ ENVIRONMENT: z.enum(["local", "staging", "production"]) });
const keySchema = z.object({ ANTHROPIC_API_KEY: z.string().trim().min(1).optional() });

export function selectAi(env: object): AiRoster {
  const environment = environmentSchema.safeParse(env).data?.ENVIRONMENT;
  const script =
    environment === "local" || environment === "staging"
      ? scriptedAi(developmentScript)
      : noProviderAi;
  const key = keySchema.safeParse(env).data?.ANTHROPIC_API_KEY;
  const provider =
    key && (environment === "staging" || environment === "production")
      ? anthropicAi({ apiKey: key, model: limits.ai.model })
      : noProviderAi;

  return {
    async forNewJob(isSmokeVerifier) {
      if (environment === "local" || (environment === "staging" && (await isSmokeVerifier())))
        return script;
      return provider;
    },
    continuing(model) {
      if (model === script.model) return script;
      if (model === provider.model) return provider;
      return noProviderAi;
    },
  };
}

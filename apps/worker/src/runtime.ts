import type { Runtime } from "./services/deps.ts";

export const systemRuntime: Runtime = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
  newTraceId: () => crypto.randomUUID(),
};

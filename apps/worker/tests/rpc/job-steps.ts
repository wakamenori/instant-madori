import assert from "node:assert/strict";
import type { JobStepConfig, JobSteps } from "../../src/services/jobs.ts";
function plain(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const prototype: unknown = Object.getPrototypeOf(value);
  assert(
    prototype === Object.prototype || prototype === Array.prototype,
    "step results are plain serializable data",
  );
  for (const child of Object.values(value)) plain(child);
}
export function stepEngine({ rerun, loseResults }: { rerun?: string; loseResults?: string } = {}) {
  const cache = new Map<string, unknown>();
  const attempts: string[] = [];
  const steps: JobSteps = {
    sleep: async () => {},
    async do<T extends Rpc.Serializable<T> & { kind: string }>(
      name: string,
      config: JobStepConfig,
      body: () => Promise<T>,
    ) {
      if (cache.has(name)) return structuredClone(cache.get(name)) as T;
      for (let attempt = 0; ; attempt++) {
        attempts.push(name);
        try {
          if (name === rerun) {
            plain(await body());
          }
          const result = await body();
          plain(result);
          if (name === loseResults) throw new Error("Step result lost");
          cache.set(name, result);
          return structuredClone(result);
        } catch (error) {
          if (attempt === config.retries.limit) throw error;
        }
      }
    },
  };
  return { steps, cache, attempts };
}

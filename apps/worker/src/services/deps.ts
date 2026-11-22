import type { Ai } from "../ai/round-trip.ts";
import type { JobStepName, JobStepResult } from "./jobs.ts";
import type { JobTestHold } from "./job-test-hold.ts";
import type { JobExecutionReference } from "../storage/job-execution.ts";
import type { Store } from "../storage/store.ts";
import type { GeometryApi, GeometryInstance } from "../geometry/geometry-client.ts";
/**
 * What services need from the outside world. Services never read the clock or generate IDs
 * themselves, so tests and replays can control both.
 */
export interface Runtime {
  /** Current time as an ISO 8601 UTC string. */
  now(): string;
  /** A new random UUID for a stored entity (user, project, pattern). */
  newId(): string;
  /**
   * A new random ID for one request's log line and `x-trace-id` header. Separate from
   * `newId` so that requests never consume entity IDs from a controlled sequence.
   */
  newTraceId(): string;
}

export interface ServiceDeps {
  store: Store;
  geometry: (key: GeometryInstance) => GeometryApi;
  runtime: Runtime;
  wakePattern: (patternId: string) => Promise<void>;
}

export type StoreDeps<K extends keyof Store, O extends keyof Store[K]> = {
  store: { [P in K]: Pick<Store[P], O> };
};

export type RunObservation =
  { kind: "started" } | { kind: "progressing" | "stalled" | "ended"; instanceStatus: string };

export interface JobRuns {
  observe(job: JobExecutionReference): Promise<RunObservation>;
}

export interface JobStepConfig {
  retries: { limit: number; delay: number; backoff: "exponential" };
  timeout: number;
}

export interface JobSteps {
  sleep(name: string, ms: number): Promise<void>;
  do<T extends Rpc.Serializable<T> & JobStepResult>(
    name: JobStepName,
    config: JobStepConfig,
    run: () => Promise<T>,
  ): Promise<T>;
}

export type Reconciliation =
  | { kind: "queue_held"; heldBy: string }
  | { kind: "idle" }
  | { kind: "claimed" | "run_restarted" | "settled_meanwhile"; job: JobExecutionReference }
  | {
      kind: "running" | "stalled" | "failed_lost_run";
      job: JobExecutionReference;
      instanceStatus: string;
    };

export type StalledPatternSweepDeps = StoreDeps<"jobs", "stalledPatterns"> &
  Pick<ServiceDeps, "runtime" | "wakePattern">;

export type PatternCoordinatorDeps = StoreDeps<
  "jobs",
  "claim" | "activeJob" | "holdingJob" | "restore" | "failAndHoldQueue"
> &
  Pick<ServiceDeps, "runtime"> & { jobRuns: JobRuns };

export type JobWorkflowDeps = StoreDeps<
  "jobs",
  "restore" | "check" | "complete" | "failAndHoldQueue" | "ownedBySubject"
> &
  StoreDeps<"snapshots", "write"> &
  Pick<ServiceDeps, "geometry" | "runtime" | "wakePattern"> & {
    ai: Ai;
    testHold: JobTestHold | null;
  };

export type AiCostDeps = StoreDeps<"aiCost", "reserve" | "settle"> & Pick<ServiceDeps, "runtime">;

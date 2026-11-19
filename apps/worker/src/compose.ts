import { jobTestHoldSettingSchema } from "./services/job-test-hold.ts";
import { geometryClient } from "./geometry/geometry-client.ts";
import { d1 } from "./storage/d1.ts";
import { r2 } from "./storage/r2.ts";
import { createStore } from "./storage/store.ts";
import { jobRuns } from "./workflows/job-runs.ts";
import type { JobExecutionReference } from "./services/jobs.ts";
import type {
  JobWorkflowDeps,
  PatternCoordinatorDeps,
  Runtime,
  ServiceDeps,
} from "./services/deps.ts";

export function serviceDeps(
  env: Pick<Env, "DB" | "BLOBS" | "GEOMETRY" | "PATTERNS">,
  runtime: Runtime,
): ServiceDeps {
  return {
    store: createStore(d1(env.DB), r2(env.BLOBS)),
    runtime,
    wakePattern: patternWake(env),
    geometry: geometryClient((name) => env.GEOMETRY.getByName(name)),
  };
}

function patternWake(env: Pick<Env, "PATTERNS">): ServiceDeps["wakePattern"] {
  return (patternId) => env.PATTERNS.getByName(patternId).wake();
}

export function patternCoordinatorDeps(
  env: Pick<Env, "DB" | "BLOBS">,
  workflow: Pick<Workflow<JobExecutionReference>, "createBatch">,
  runtime: Runtime,
): PatternCoordinatorDeps {
  const { jobs } = createStore(d1(env.DB), r2(env.BLOBS));
  return {
    store: { jobs: { claim: jobs.claim, activeReference: jobs.activeReference } },
    jobRuns: jobRuns(workflow),
    runtime,
  };
}

export function jobWorkflowDeps(
  env: Pick<Env, "DB" | "BLOBS" | "GEOMETRY" | "PATTERNS" | "ENVIRONMENT" | "JOB_TEST_HOLD">,
  runtime: Runtime,
): JobWorkflowDeps {
  const { jobs, snapshots } = createStore(d1(env.DB), r2(env.BLOBS));
  return {
    store: {
      jobs: {
        restore: jobs.restore,
        check: jobs.check,
        complete: jobs.complete,
        fail: jobs.fail,
        ownedBySubject: jobs.ownedBySubject,
      },
      snapshots: { write: snapshots.write },
    },
    testHold: jobTestHoldSettingSchema.parse(env),
    runtime,
    geometry: geometryClient((name) => env.GEOMETRY.getByName(name)),
    wakePattern: patternWake(env),
  };
}

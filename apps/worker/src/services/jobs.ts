import { limits } from "../limits.ts";
import { verifierSubject } from "../identity.ts";
import type { JobTestHold, TestHoldPoint } from "./job-test-hold.ts";
import { z } from "zod";
import { renderPatternSample } from "./geometry.ts";
import type { GeometryFailure } from "./geometry.ts";
import type {
  JobStepConfig,
  JobSteps,
  JobWorkflowDeps,
  Reconciliation,
  StalledPatternSweepDeps,
  PatternCoordinatorDeps,
} from "./deps.ts";
import { instructionBodySchema, nameSchema } from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import type { AcceptedJob } from "@madori/contracts";
import type { JobStop } from "../storage/jobs.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";
import { requestKey } from "./requests.ts";
import type { JobExecutionReference, JobExecutionRight } from "../storage/job-execution.ts";
import type { Snapshot } from "../storage/snapshots.ts";

export type AcceptInstructionOutcome =
  | { kind: "accepted"; acceptance: "applied" | "replayed"; job: AcceptedJob }
  | { kind: "attachment_unavailable" }
  | { kind: "invalid_message" }
  | { kind: "not_found" }
  | { kind: "request_id_reused" };

export async function acceptInstruction(
  {
    store,
    runtime,
    wakePattern,
  }: StoreDeps<"jobs", "acceptOnce"> &
    StoreDeps<"patterns", "get"> &
    Pick<ServiceDeps, "runtime" | "wakePattern">,
  input: {
    ownerId: OwnerId;
    requestId: string;
    patternId: string;
    body: string;
    attachmentIds?: string[];
  },
): Promise<AcceptInstructionOutcome> {
  const { ownerId, requestId, patternId, body, attachmentIds = [] } = input;
  if (
    attachmentIds.length > limits.assets.maxPerInstruction ||
    !instructionBodySchema.safeParse(body).success
  ) {
    return { kind: "invalid_message" };
  }
  const key = await requestKey(
    ownerId,
    requestId,
    "instruction.accept",
    attachmentIds.length
      ? { patternId, body, attachmentIds: attachmentIds.join(",") }
      : { patternId, body },
  );
  const once = await store.jobs.acceptOnce(key, {
    id: runtime.newId(),
    messageId: runtime.newId(),
    patternId,
    body,
    attachmentIds,
    now: runtime.now(),
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      await wakePattern(patternId);
      return { kind: "accepted", acceptance: once.kind, job: once.result };
    case "not_applied":
      if (attachmentIds.length && (await store.patterns.get({ patternId, ownerId })))
        return { kind: "attachment_unavailable" };
      return { kind: "not_found" };
    case "request_id_reused":
      return once;
  }
}

export type StopJobOutcome =
  | {
      kind: "stop";
      record: "applied" | "replayed";
      result: Extract<JobStop, { kind: "applied" | "replayed" }>["result"];
    }
  | { kind: "not_found" }
  | { kind: "request_id_reused" };

export async function stopJob(
  {
    store,
    runtime,
    wakePattern,
  }: StoreDeps<"jobs", "stopOnce"> & Pick<ServiceDeps, "runtime" | "wakePattern">,
  input: { ownerId: OwnerId; requestId: string; jobId: string },
): Promise<StopJobOutcome> {
  const { ownerId, requestId, jobId } = input;
  const key = await requestKey(ownerId, requestId, "job.stop", { jobId });
  const once = await store.jobs.stopOnce(key, { jobId, now: runtime.now() });
  if (once.kind === "not_found" || once.kind === "request_id_reused") return once;
  if (once.result.outcome === "stopped") await wakePattern(once.result.patternId);
  return { kind: "stop", record: once.kind, result: once.result };
}

interface ReleaseInput {
  ownerId: OwnerId;
  requestId: string;
  patternId: string;
  heldBy: string;
}
type ReleaseDeps = StoreDeps<"queue", "resumeOnce" | "cancelOnce"> &
  StoreDeps<"patterns", "get"> &
  Pick<ServiceDeps, "runtime" | "wakePattern">;
export async function releaseQueue(
  { store, runtime, wakePattern }: ReleaseDeps,
  input: ReleaseInput,
  action: "resume" | "cancel",
) {
  const { ownerId, requestId, patternId, heldBy } = input;
  const key = await requestKey(ownerId, requestId, `queue.${action}`, { patternId, heldBy });
  const releaseOnce = action === "resume" ? store.queue.resumeOnce : store.queue.cancelOnce;
  const once = await releaseOnce(key, { patternId, heldBy, now: runtime.now() });
  switch (once.kind) {
    case "not_applied": {
      const pattern = await store.patterns.get({ patternId, ownerId });
      return pattern ? { kind: "version_conflict" as const } : { kind: "not_found" as const };
    }
    case "request_id_reused":
      return once;
    case "applied":
    case "replayed":
      if (action === "resume") await wakePattern(patternId);
      return { kind: "released" as const, record: once.kind, result: once.result };
  }
}
export function claimNextJob(
  { store, runtime }: StoreDeps<"jobs", "claim"> & Pick<ServiceDeps, "runtime">,
  input: { patternId: string },
) {
  return store.jobs.claim({ patternId: input.patternId, now: runtime.now() });
}

export function readCurrentJobExecution(
  { store }: StoreDeps<"jobs", "restore">,
  reference: JobExecutionReference,
) {
  return store.jobs.restore(reference);
}

export function readActiveJob(
  { store }: StoreDeps<"jobs", "activeJob">,
  input: { patternId: string },
) {
  return store.jobs.activeJob(input);
}

export async function saveJobSnapshot(
  {
    store,
    runtime,
  }: StoreDeps<"jobs", "check"> & StoreDeps<"snapshots", "write"> & Pick<ServiceDeps, "runtime">,
  input: { right: JobExecutionRight; display: Uint8Array<ArrayBuffer> },
) {
  const { right, display } = input;
  const status = await store.jobs.check(right);
  if (status.kind !== "active") return status;
  const snapshot = await store.snapshots.write(right, {
    id: runtime.newId(),
    now: runtime.now(),
    display,
  });
  return { kind: "saved" as const, snapshot };
}

export async function completeJob(
  { store, runtime }: StoreDeps<"jobs", "check" | "complete"> & Pick<ServiceDeps, "runtime">,
  input: { right: JobExecutionRight; name: string; snapshot: Snapshot },
) {
  const { right, name: suppliedName, snapshot } = input;
  const status = await store.jobs.check(right);
  if (status.kind !== "active") return status;
  const name = nameSchema.safeParse(suppliedName);
  if (!name.success) return { kind: "invalid_name" as const };
  return store.jobs.complete(right, {
    id: runtime.newId(),
    name: name.data,
    snapshot,
    now: runtime.now(),
  });
}

export function recordJobFailure(
  { store, runtime }: StoreDeps<"jobs", "failAndHoldQueue"> & Pick<ServiceDeps, "runtime">,
  right: JobExecutionRight,
) {
  return store.jobs.failAndHoldQueue(right, runtime.now());
}

export type { JobExecutionReference } from "../storage/job-execution.ts";
export type { JobRuns, JobSteps, JobStepConfig } from "./deps.ts";
export const jobReferenceSchema = z.strictObject({
  patternId: z.uuid(),
  jobId: z.uuid(),
  generation: z.int().positive(),
});
type JobFailureReason =
  GeometryFailure | "execution_lost" | "invalid_snapshot" | "invalid_name" | "retries_exhausted";
type Committed = { kind: "committed"; revisionId: string };
type Cancelled = { kind: "cancelled" };
type Saved = { kind: "saved"; snapshot: Snapshot };
type TestHoldDecision = { kind: "hold"; seconds: number } | { kind: "skip" };
type NotCommitted = { kind: "not_committed"; reason: JobFailureReason };
export type JobEnd =
  | Committed
  | Cancelled
  | { kind: "failed"; reason: JobFailureReason }
  | { kind: "not_running"; reason: JobFailureReason };
export type JobStepResult = Saved | NotCommitted | JobEnd | TestHoldDecision | { kind: "woken" };

export const recovery = {
  stalledRunGraceMs: 24 * 60 * 60 * 1000,
  sweepUnchangedMs: 5 * 60 * 1000,
  sweepLimit: 200,
} as const;

export async function reconcilePattern(
  deps: PatternCoordinatorDeps,
  input: { patternId: string },
): Promise<Reconciliation> {
  const claim = await claimNextJob(deps, input);
  if (claim.kind === "claimed") {
    const job = claim.right.reference;
    await deps.jobRuns.observe(job);
    return { kind: "claimed", job };
  }
  const active = await readActiveJob(deps, input);
  if (!active) {
    const hold = await deps.store.jobs.holdingJob(input.patternId);
    return hold ? { kind: "queue_held", heldBy: hold.heldBy } : { kind: "idle" };
  }
  const job = active.reference;
  const run = await deps.jobRuns.observe(job);
  if (run.kind === "started") return { kind: "run_restarted", job };
  const { instanceStatus } = run;
  if (run.kind === "progressing") return { kind: "running", job, instanceStatus };
  if (
    run.kind === "stalled" &&
    Date.parse(deps.runtime.now()) - Date.parse(active.claimedAt) < recovery.stalledRunGraceMs
  )
    return { kind: "stalled", job, instanceStatus };
  const execution = await readCurrentJobExecution(deps, job);
  if (
    execution.kind === "active" &&
    (await recordJobFailure(deps, execution.right)).kind === "recorded"
  )
    return { kind: "failed_lost_run", job, instanceStatus };
  return { kind: "settled_meanwhile", job };
}

const watchesAfter = {
  claimed: true,
  run_restarted: true,
  running: true,
  stalled: true,
  failed_lost_run: true,
  settled_meanwhile: true,
  queue_held: false,
  idle: false,
} satisfies Record<Reconciliation["kind"], boolean>;

export function keepsWatching(outcome: Reconciliation) {
  return watchesAfter[outcome.kind];
}

export async function sweepStalledPatterns(deps: StalledPatternSweepDeps) {
  const unchangedSince = new Date(
    Date.parse(deps.runtime.now()) - recovery.sweepUnchangedMs,
  ).toISOString();
  const ids = await deps.store.jobs.stalledPatterns({ unchangedSince, limit: recovery.sweepLimit });
  const wakes = await Promise.allSettled(ids.map(async (id) => deps.wakePattern(id)));
  const wakeFailed = wakes.filter((wake) => wake.status === "rejected").length;
  return {
    found: ids.length,
    woken: ids.length - wakeFailed,
    wakeFailed,
    truncated: ids.length === recovery.sweepLimit,
  };
}

export const sampleRevisionName = "サンプルの形";
const storageStep = {
  retries: { limit: 5, delay: 2_000, backoff: "exponential" },
  timeout: 60_000,
} as const satisfies JobStepConfig;
// Step names are durable cache keys for instances already running.
const jobSteps = {
  render: {
    name: "render snapshot",
    config: { retries: { limit: 3, delay: 5_000, backoff: "exponential" }, timeout: 180_000 },
  },
  commit: { name: "commit revision", config: storageStep },
  fail: { name: "record failure", config: storageStep },
  wake: { name: "wake pattern", config: storageStep },
} as const satisfies Record<string, { name: string; config: JobStepConfig }>;

export type JobStepName =
  (typeof jobSteps)[keyof typeof jobSteps]["name"] | (typeof testHoldSteps)[TestHoldPoint]["check"];

export async function runJob(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  steps: JobSteps,
): Promise<JobEnd> {
  let settled: Committed | Cancelled | NotCommitted;
  try {
    await holdForTest(deps, job, steps, "before_render");
    const rendered = await steps.do(jobSteps.render.name, jobSteps.render.config, () =>
      render(deps, job),
    );
    if (rendered.kind === "saved") {
      await holdForTest(deps, job, steps, "before_commit");
      settled = await steps.do(jobSteps.commit.name, jobSteps.commit.config, () =>
        commit(deps, job, rendered.snapshot),
      );
    } else settled = rendered;
  } catch {
    settled = { kind: "not_committed", reason: "retries_exhausted" };
  }
  const end =
    settled.kind !== "not_committed"
      ? settled
      : await steps.do(jobSteps.fail.name, jobSteps.fail.config, () =>
          endWithoutRevision(deps, job, settled.reason),
        );
  await steps.do(jobSteps.wake.name, jobSteps.wake.config, async () => {
    await deps.wakePattern(job.patternId);
    return { kind: "woken" } as const;
  });
  return end;
}

async function current(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
): Promise<{ kind: "active"; right: JobExecutionRight } | Committed | Cancelled | NotCommitted> {
  const restored = await readCurrentJobExecution(deps, job);
  if (restored.kind === "cancelled") return { kind: "cancelled" };
  if (restored.kind === "invalid") return { kind: "not_committed", reason: "execution_lost" };
  return restored.kind === "committed"
    ? { kind: "committed", revisionId: restored.revision.id }
    : { kind: "active", right: restored.right };
}

async function render(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
): Promise<Saved | Committed | Cancelled | NotCommitted> {
  const now = await current(deps, job);
  if (now.kind !== "active") return now;
  const sample = await renderPatternSample(deps, { patternId: job.patternId, traceId: job.jobId });
  if (sample.kind === "retry") throw new Error(`Geometry unavailable: ${sample.reason}`);
  if (sample.kind === "failed") return { kind: "not_committed", reason: sample.reason };
  const saved = await saveJobSnapshot(deps, { right: now.right, display: sample.display });
  if (saved.kind === "committed") return { kind: "committed", revisionId: saved.revision.id };
  return saved.kind === "execution_lost" ? { kind: "not_committed", reason: saved.kind } : saved;
}

async function commit(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  snapshot: Snapshot,
): Promise<Committed | Cancelled | NotCommitted> {
  const now = await current(deps, job);
  if (now.kind !== "active") return now;
  const result = await completeJob(deps, { right: now.right, name: sampleRevisionName, snapshot });
  return result.kind === "committed"
    ? { kind: "committed", revisionId: result.revision.id }
    : { kind: "not_committed", reason: result.kind };
}

async function endWithoutRevision(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  reason: JobFailureReason,
): Promise<JobEnd> {
  const now = await current(deps, job);
  if (now.kind === "committed" || now.kind === "cancelled") return now;
  if (now.kind === "not_committed") return { kind: "not_running", reason };
  const result = await recordJobFailure(deps, now.right);
  if (result.kind === "recorded") return { kind: "failed", reason };
  const latest = await current(deps, job);
  return latest.kind === "cancelled" || latest.kind === "committed"
    ? latest
    : { kind: "not_running", reason };
}

const testHoldSteps = {
  before_render: { check: "check test hold before render", sleep: "test hold before render" },
  before_commit: { check: "check test hold before commit", sleep: "test hold before commit" },
} as const satisfies Record<TestHoldPoint, { check: string; sleep: string }>;

async function holdForTest(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  steps: JobSteps,
  at: TestHoldPoint,
) {
  const hold = deps.testHold;
  if (hold === null || hold.at !== at) return;
  const decision = await steps.do(testHoldSteps[at].check, storageStep, () =>
    decideTestHold(deps, job, hold),
  );
  if (decision.kind === "hold") await steps.sleep(testHoldSteps[at].sleep, decision.seconds * 1000);
}

async function decideTestHold(
  { store }: StoreDeps<"jobs", "restore" | "ownedBySubject">,
  job: JobExecutionReference,
  hold: JobTestHold,
): Promise<TestHoldDecision> {
  const restored = await store.jobs.restore(job);
  if (restored.kind !== "active") return { kind: "skip" };
  if (
    hold.scope === "verifier" &&
    !(await store.jobs.ownedBySubject(restored.right, verifierSubject))
  )
    return { kind: "skip" };
  return { kind: "hold", seconds: hold.seconds };
}

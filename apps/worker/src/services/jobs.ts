import { meteredRoundTrip } from "./ai-cost.ts";
import { limits, type JobLimit } from "../limits.ts";
import { verifierSubject } from "../identity.ts";
import type { Conversation } from "../ai/round-trip.ts";
import type { JobWorkPath } from "../storage/job-work.ts";
import type { EditHouseInput } from "@madori/contracts/ai-tools";
import { emptyHouseSummary, houseSummarySchema } from "@madori/contracts/geometry-internal";
import { prefix, prefixSchema, conversationWindow } from "./ai-context.ts";
import {
  planRound,
  explanationBody,
  v1Notice,
  limitNotices,
  elements,
  toolText,
  type RoundPlan,
} from "./job-conversation.ts";
import { z } from "zod";
import { applyHouseOperations, summarizeHouse } from "./geometry.ts";
import type { GeometryFailure } from "./geometry.ts";
import type {
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
  | { kind: "version_conflict" }
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
    questionId?: string | undefined;
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
  const key = await requestKey(ownerId, requestId, "instruction.accept", {
    patternId,
    body,
    ...(input.questionId && { questionId: input.questionId }),
    ...(attachmentIds.length && { attachmentIds: attachmentIds.join(",") }),
  });
  const once = await store.jobs.acceptOnce(key, {
    id: runtime.newId(),
    messageId: runtime.newId(),
    patternId,
    body,
    attachmentIds,
    ...(input.questionId && { questionId: input.questionId }),
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
    case "not_found":
    case "version_conflict":
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

export async function completeJob(
  { store, runtime }: StoreDeps<"jobs", "check" | "complete"> & Pick<ServiceDeps, "runtime">,
  input: {
    right: JobExecutionRight;
    name: string;
    snapshot: Snapshot;
    explanation: string;
    v1Base?: boolean;
  },
) {
  const { right, name: suppliedName, snapshot } = input;
  const status = await store.jobs.check(right);
  if (status.kind !== "active") return status;
  const name = nameSchema.safeParse(suppliedName);
  if (!name.success) return { kind: "invalid_name" as const };
  return store.jobs.complete(right, {
    id: runtime.newId(),
    name: name.data,
    explanation: { id: runtime.newId(), body: input.explanation },
    notice: input.v1Base ? { id: runtime.newId(), body: v1Notice } : null,
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
  | "ai_refused"
  | "ai_rejected"
  | "ai_script_ended"
  | "ai_unavailable"
  | "ai_output_limit"
  | GeometryFailure
  | "execution_lost"
  | "invalid_snapshot"
  | "invalid_name"
  | "retries_exhausted";
type Committed = { kind: "committed"; revisionId: string };
type Asked = { kind: "asked" };
type Limited = { kind: "limited"; limit: JobLimit | null };
type Cancelled = { kind: "cancelled" };
type NotCommitted = { kind: "not_committed"; reason: JobFailureReason };
export type JobEnd = (
  | Committed
  | Asked
  | Cancelled
  | Limited
  | { kind: "failed"; reason: JobFailureReason }
  | { kind: "not_running"; reason: JobFailureReason }
) & { ms?: number };
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

const jobLimits = {
  maxCallsPerRound: 8,
  maxOutputTokens: 32000,
  toolResultMaxBytes: 32768,
};
const storageStep = {
  retries: { limit: 5, delay: 2000, backoff: "exponential" },
  timeout: 60000,
} as const;
const aiStep = {
  retries: { limit: 2, delay: 10000, backoff: "exponential" },
  timeout: 600000,
} as const;
const geometryStep = {
  retries: { limit: 3, delay: 5000, backoff: "exponential" },
  timeout: 180000,
} as const;
type WorkRef = { path: JobWorkPath; sha256: string };
type ToolResult = { callId: string; text: string; isError: boolean };
type History = {
  turn: WorkRef;
  reply: { kind: "message"; text: string } | { kind: "tool_results"; results: ToolResult[] };
}[];
type Interrupted = Committed | Asked | Cancelled | Limited | NotCommitted;
type Working = { kind: "empty"; v1Base: boolean } | { kind: "edited" | "base"; snapshot: Snapshot };
type Started = { kind: "started"; claimedAt: string; working: Working; prefix: WorkRef };
type Answer = ({ kind: "answered" } | { kind: "hold"; seconds: number }) & {
  turn: WorkRef;
  plan: RoundPlan;
};
type Edited = { kind: "edited"; snapshot: Snapshot; result: ToolResult };
type Refused = { kind: "refused"; result: ToolResult };
type Checked =
  | { kind: "accepted"; snapshot: Snapshot }
  | { kind: "blocked"; snapshot: Snapshot; result: ToolResult };
type Timings = Partial<Record<"aiMs" | "saveMs" | "checkMs" | "geometryMs", number>>;
export type JobStepResult = (
  | Started
  | Answer
  | Edited
  | Refused
  | Checked
  | { kind: "read"; result: ToolResult }
  | { kind: "woken"; ms?: number }
  | JobEnd
  | NotCommitted
) & { timings?: Timings };

function result(callId: string, value: unknown, isError = false): ToolResult {
  return { callId, text: toolText(value, jobLimits.toolResultMaxBytes), isError };
}
async function files(deps: JobWorkflowDeps, snapshot: Snapshot) {
  const { house } = await deps.store.snapshots.open(snapshot);
  if (!house) throw new Error("Missing working house");
  return house;
}
async function houseText(deps: JobWorkflowDeps, snapshot: Snapshot) {
  return new TextDecoder().decode(await (await files(deps, snapshot)).data.read());
}

async function startJob(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
): Promise<Started | Interrupted> {
  const live = await current(deps, job);
  if (live.kind !== "active") return live;
  let kept = await deps.store.work.read(live.right, "prefix.json");
  const context = await deps.store.jobs.startContext(live.right, conversationWindow);
  if (!context) return { kind: "not_committed", reason: "execution_lost" };
  const base = context.base;
  const working: Working =
    base?.formatVersion === 2
      ? { kind: "base", snapshot: base }
      : { kind: "empty", v1Base: base !== null };
  if (!kept) {
    let summary = houseSummarySchema.parse(emptyHouseSummary);
    let checks = null;
    if (working.kind === "base") {
      const file = await files(deps, working.snapshot);
      const json = new TextDecoder().decode(await file.data.read());
      const response = await summarizeHouse(deps, job.patternId, job.jobId, {
        snapshot: { kind: "house", json },
      });
      if (response.kind === "retry") throw new Error(response.reason);
      if (response.kind === "failed") return { kind: "not_committed", reason: response.reason };
      summary = response.value;
      checks = new TextDecoder().decode(await file.checks.read());
    }
    const built = await prefix(deps.ai.model, { ...context, summary, checks });
    kept = await deps.store.work.keep(live.right, "prefix.json", JSON.stringify(built));
  }
  const recorded = await deps.store.jobs.recordAi(
    live.right,
    prefixSchema.parse(JSON.parse(kept.text)),
  );
  if (!recorded) return { kind: "not_committed", reason: "execution_lost" };
  return { kind: "started", claimedAt: context.claimedAt, working, prefix: kept.ref };
}

async function ask(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  start: Started,
  history: History,
  round: number,
): Promise<(Answer | Interrupted) & { timings?: Timings }> {
  const live = await current(deps, job);
  if (live.kind !== "active") return live;
  const right = live.right;
  const path = `rounds/${round}.json` as const;
  let kept = await deps.store.work.read(right, path);
  const timings: Timings = {};
  async function read(ref: WorkRef) {
    const object = await deps.store.work.read(right, ref.path, ref.sha256);
    if (!object) throw new Error("Missing conversation object");
    return object.text;
  }
  if (!kept) {
    const initial = prefixSchema.parse(JSON.parse(await read(start.prefix)));
    const rounds: Conversation["rounds"] = await Promise.all(
      history.map(async ({ turn, reply }) => ({
        assistant: deps.turns.decode(await read(turn)).assistant,
        reply:
          reply.kind === "message"
            ? { kind: "message" as const, parts: [{ kind: "text" as const, text: reply.text }] }
            : {
                kind: "tool_results" as const,
                results: reply.results.map((r) => ({
                  callId: r.callId,
                  isError: r.isError,
                  content: [{ kind: "text" as const, text: r.text }],
                })),
              },
      })),
    );
    const time = Date.parse(deps.runtime.now());
    const response = await meteredRoundTrip(deps, right, {
      conversation: {
        system: initial.system,
        tools: initial.tools,
        opening: initial.opening,
        rounds,
      },
      maxOutputTokens: jobLimits.maxOutputTokens,
    });
    timings.aiMs = Date.parse(deps.runtime.now()) - time;
    if (response.kind === "limited") return endLimited(deps, right, response.limit);
    if (response.kind === "execution_lost") return afterExecutionLost(deps, job);
    if (response.kind === "failed")
      return {
        kind: "not_committed",
        reason: (
          {
            rejected: "ai_rejected",
            script_ended: "ai_script_ended",
            no_provider: "ai_unavailable",
          } as const
        )[response.reason],
        timings,
      };
    kept = await deps.store.work.keep(right, path, deps.turns.encode(response));
  }
  const plan = planRound(deps.turns.decode(kept.text), jobLimits.maxCallsPerRound);
  const answer = { turn: kept.ref, plan, timings };
  const hold = deps.testHold;
  if (
    hold &&
    (hold.at === "first_answer" ? round === 1 : plan.kind === "finish" || plan.kind === "ask") &&
    (hold.scope === "every_job" || (await deps.store.jobs.ownedBySubject(right, verifierSubject)))
  )
    return { kind: "hold", seconds: hold.seconds, ...answer };
  return { kind: "answered", ...answer };
}

async function apply(
  deps: JobWorkflowDeps,
  right: JobExecutionRight,
  working: Working,
  operationId: string,
  operations: EditHouseInput["operations"],
  callId: string,
): Promise<(Edited | Refused | Interrupted) & { timings?: Timings }> {
  const job = right.reference;
  const response = await applyHouseOperations(deps, job.patternId, {
    job_id: job.jobId,
    generation: job.generation,
    operation_id: operationId,
    operations,
    snapshot:
      working.kind === "empty"
        ? { kind: "empty" }
        : { kind: "house", json: await houseText(deps, working.snapshot) },
  });
  if (response.kind === "retry") throw new Error(response.reason);
  if (response.kind === "failed") return { kind: "not_committed", reason: response.reason };
  const value = response.value;
  const timings: Timings = { geometryMs: response.ms };
  if (value.kind !== "applied")
    return { kind: "refused", result: result(callId, value, true), timings };
  const time = Date.parse(deps.runtime.now());
  const active = await current(deps, job);
  if (active.kind !== "active") return active;
  const part = (kind: "house" | "display") => {
    const found = value.parts.find((p) => p.artifact.kind === kind);
    if (!found) throw new Error("Missing " + kind);
    return new Uint8Array(found.bytes);
  };
  const snapshot = await deps.store.snapshots.write(right, {
    id: deps.runtime.newId(),
    now: deps.runtime.now(),
    display: part("display"),
    house: {
      data: part("house"),
      checks: new Uint8Array(new TextEncoder().encode(JSON.stringify(value.inspection))),
      floorPlans: value.parts.flatMap((p) =>
        p.artifact.kind === "floor_plan"
          ? [{ storey: p.artifact.storey, svg: new Uint8Array(p.bytes) }]
          : [],
      ),
    },
  });
  timings.saveMs = Date.parse(deps.runtime.now()) - time;
  return {
    kind: "edited",
    snapshot,
    result: result(callId, { operations: value.operations, inspection: value.inspection }),
    timings,
  };
}

async function converse(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  steps: JobSteps,
  start: Started,
): Promise<Interrupted> {
  let working = start.working;
  let blocked = 0;
  const history: History = [];
  const recordLimit = (limit: keyof typeof limits.jobRun) =>
    steps.do("record limit", storageStep, async (): Promise<Interrupted> => {
      const live = await current(deps, job);
      // A cost limit returns from `ask` before converse reaches a run cap, so a
      // limited row here was written by this step; a retry keeps the kind.
      if (live.kind === "limited") return { kind: "limited", limit };
      if (live.kind !== "active") return live;
      return endLimited(deps, live.right, limit);
    });
  for (let round = 1; round <= limits.jobRun.rounds; round++) {
    const answer = await steps.do(`round ${round} ai`, aiStep, () =>
      ask(deps, job, start, history, round),
    );
    if (answer.kind !== "answered" && answer.kind !== "hold") return answer;
    if (answer.kind === "hold") await steps.sleep(`round ${round} hold`, answer.seconds * 1000);
    const { plan, turn } = answer;
    if (plan.kind === "stop") return { kind: "not_committed", reason: plan.reason };
    if (plan.kind === "ask")
      return steps.do(`round ${round} ask`, storageStep, async () => {
        const live = await current(deps, job);
        if (live.kind !== "active") return live;
        await deps.store.jobs.askQuestion(live.right, {
          id: deps.runtime.newId(),
          body: plan.answer.question,
          choices: plan.answer.choices,
          now: deps.runtime.now(),
        });
        const settled = await current(deps, job);
        return settled.kind === "active"
          ? { kind: "not_committed" as const, reason: "execution_lost" as const }
          : settled;
      });
    if (plan.kind === "nudge") {
      history.push({
        turn,
        reply: { kind: "message", text: "Call finish alone with the completed plan." },
      });
      continue;
    }
    const results: ToolResult[] = [];
    const operationPrefix = `${job.jobId}.g${job.generation}.r${round}`;
    if (plan.kind === "calls") {
      for (const [i, { id, call }] of plan.calls.entries()) {
        if (call.name === "invalid") {
          results.push(result(id, call.error, true));
          continue;
        }
        const before = working;
        if (call.name === "edit_house") {
          const edit = await steps.do(
            `round ${round} call ${i + 1} edit_house`,
            geometryStep,
            async () => {
              const live = await current(deps, job);
              if (live.kind !== "active") return live;
              return apply(
                deps,
                live.right,
                before,
                `${operationPrefix}.c${i + 1}`,
                call.input.operations,
                id,
              );
            },
          );
          if (edit.kind !== "edited" && edit.kind !== "refused") return edit;
          if (edit.kind === "edited") working = { kind: "edited", snapshot: edit.snapshot };
          results.push(edit.result);
        } else {
          const read = await steps.do(
            `round ${round} call ${i + 1} read_house`,
            storageStep,
            async () => {
              const live = await current(deps, job);
              if (live.kind !== "active") return live;
              const query = call.input.query;
              let data: unknown,
                error = false;
              if (before.kind === "empty" || query.kind === "dimensions") {
                error = true;
                data =
                  before.kind === "empty"
                    ? "House is empty"
                    : "Dimensions unavailable; read elements.";
              } else if (query.kind === "elements")
                data = elements(await houseText(deps, before.snapshot), query.ids);
              else
                data = JSON.parse(
                  new TextDecoder().decode(
                    await (await files(deps, before.snapshot)).checks.read(),
                  ),
                );
              return { kind: "read" as const, result: result(id, data, error) };
            },
          );
          if (read.kind !== "read") return read;
          results.push(read.result);
        }
      }
    } else {
      const before = working;
      const gate = await steps.do(`round ${round} finish`, geometryStep, async () => {
        const live = await current(deps, job);
        if (live.kind !== "active") return live;
        const time = Date.parse(deps.runtime.now());
        if (before.kind === "empty")
          return { kind: "refused" as const, result: result(plan.id, "House is empty", true) };
        let snapshot = before.snapshot;
        const timings: Timings = {};
        if (before.kind === "base") {
          const saved = await apply(
            deps,
            live.right,
            before,
            operationPrefix + ".check",
            [],
            plan.id,
          );
          if (saved.kind !== "edited") return saved;
          snapshot = saved.snapshot;
          Object.assign(timings, saved.timings);
        }
        const checks = z
          .object({ housing: z.array(z.unknown()), model: z.array(z.unknown()) })
          .parse(
            JSON.parse(new TextDecoder().decode(await (await files(deps, snapshot)).checks.read())),
          );
        timings.checkMs = Date.parse(deps.runtime.now()) - time;
        return checks.housing.length || checks.model.length
          ? { kind: "blocked" as const, snapshot, result: result(plan.id, checks, true), timings }
          : { kind: "accepted" as const, snapshot, timings };
      });
      if (gate.kind === "accepted") {
        return steps.do("commit revision", storageStep, async () => {
          const live = await current(deps, job);
          if (live.kind !== "active") return live;
          const time = Date.parse(deps.runtime.now());
          const saved = await completeJob(deps, {
            right: live.right,
            name: plan.answer.name,
            snapshot: gate.snapshot,
            explanation: explanationBody(plan.answer),
            v1Base: start.working.kind === "empty" && start.working.v1Base,
          });
          return saved.kind === "committed"
            ? {
                kind: "committed" as const,
                revisionId: saved.revision.id,
                timings: { saveMs: Date.parse(deps.runtime.now()) - time },
              }
            : { kind: "not_committed" as const, reason: saved.kind };
        });
      }
      if (gate.kind !== "blocked" && gate.kind !== "refused") return gate;
      if (gate.kind === "blocked") {
        working = { kind: "edited", snapshot: gate.snapshot };
        if (++blocked > limits.jobRun.checkFixes) return recordLimit("checkFixes");
      }
      results.push(gate.result);
    }
    history.push({ turn, reply: { kind: "tool_results", results } });
  }
  return recordLimit("rounds");
}

export async function runJob(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  steps: JobSteps,
): Promise<JobEnd> {
  let settled: Interrupted;
  let claimedAt: string | null = null;
  try {
    const start = await steps.do("start job", geometryStep, () => startJob(deps, job));
    if (start.kind === "started") {
      claimedAt = start.claimedAt;
      settled = await converse(deps, job, steps, start);
    } else settled = start;
  } catch {
    settled = { kind: "not_committed", reason: "retries_exhausted" };
  }
  const end =
    settled.kind === "not_committed"
      ? await steps.do("record failure", storageStep, () =>
          endWithoutRevision(deps, job, settled.reason),
        )
      : settled;
  const wake = await steps.do("wake pattern", storageStep, async () => {
    await deps.wakePattern(job.patternId);
    return {
      kind: "woken" as const,
      ...(claimedAt === null ? {} : { ms: Date.parse(deps.runtime.now()) - Date.parse(claimedAt) }),
    };
  });
  const duration = wake.ms === undefined ? {} : { ms: wake.ms };
  if (end.kind === "limited") return { kind: end.kind, limit: end.limit, ...duration };
  if (end.kind === "committed") return { kind: end.kind, revisionId: end.revisionId, ...duration };
  if (end.kind === "cancelled" || end.kind === "asked") return { kind: end.kind, ...duration };
  return { kind: end.kind, reason: end.reason, ...duration };
}
async function current(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
): Promise<{ kind: "active"; right: JobExecutionRight } | Interrupted> {
  const restored = await readCurrentJobExecution(deps, job);
  if (restored.kind === "limited") return { kind: "limited", limit: null };
  if (restored.kind === "asked" || restored.kind === "cancelled") return restored;
  if (restored.kind === "invalid") return { kind: "not_committed", reason: "execution_lost" };
  return restored.kind === "committed"
    ? { kind: "committed", revisionId: restored.revision.id }
    : { kind: "active", right: restored.right };
}

async function afterExecutionLost(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
): Promise<Interrupted> {
  const live = await current(deps, job);
  return live.kind === "active" ? { kind: "not_committed", reason: "execution_lost" } : live;
}

async function endLimited(
  deps: JobWorkflowDeps,
  right: JobExecutionRight,
  limit: JobLimit,
): Promise<Interrupted> {
  const result = await deps.store.jobs.limit(right, {
    notice: { id: deps.runtime.newId(), body: limitNotices[limit] },
    now: deps.runtime.now(),
  });
  return result.kind === "recorded"
    ? { kind: "limited", limit }
    : afterExecutionLost(deps, right.reference);
}

async function endWithoutRevision(
  deps: JobWorkflowDeps,
  job: JobExecutionReference,
  reason: JobFailureReason,
): Promise<JobEnd> {
  const now = await current(deps, job);
  if (now.kind === "not_committed") return { kind: "not_running", reason };
  if (now.kind !== "active") return now;
  const result = await recordJobFailure(deps, now.right);
  if (result.kind === "recorded") return { kind: "failed", reason };
  const latest = await afterExecutionLost(deps, job);
  return latest.kind === "not_committed" ? { kind: "not_running", reason } : latest;
}

import { instructionBodySchema, nameSchema } from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import type { Acceptance } from "../storage/jobs.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";
import { requestKey } from "./requests.ts";
import type { JobExecutionReference, JobExecutionRight } from "../storage/job-execution.ts";
import type { Snapshot } from "../storage/snapshots.ts";

export type AcceptInstructionOutcome =
  | ({ kind: "accepted"; acceptance: "applied" | "replayed" } & Acceptance)
  | { kind: "invalid_message" }
  | { kind: "not_found" }
  | { kind: "request_id_reused" };

export async function acceptInstruction(
  { store, runtime }: StoreDeps<"jobs", "acceptOnce"> & Pick<ServiceDeps, "runtime">,
  input: { ownerId: OwnerId; requestId: string; patternId: string; body: string },
): Promise<AcceptInstructionOutcome> {
  const { ownerId, requestId, patternId, body } = input;
  if (!instructionBodySchema.safeParse(body).success) {
    return { kind: "invalid_message" };
  }
  const key = await requestKey(ownerId, requestId, "instruction.accept", { patternId, body });
  const once = await store.jobs.acceptOnce(key, {
    id: runtime.newId(),
    messageId: runtime.newId(),
    patternId,
    body,
    now: runtime.now(),
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: "accepted", acceptance: once.kind, ...once.result };
    case "not_applied":
      return { kind: "not_found" };
    case "request_id_reused":
      return once;
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

export function readActiveJobReference(
  { store }: StoreDeps<"jobs", "activeReference">,
  input: { patternId: string },
) {
  return store.jobs.activeReference(input);
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
  { store, runtime }: StoreDeps<"jobs", "fail"> & Pick<ServiceDeps, "runtime">,
  right: JobExecutionRight,
) {
  return store.jobs.fail(right, runtime.now());
}

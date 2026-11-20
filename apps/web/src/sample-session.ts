import { acceptInstructionRequestSchema, createProjectRequestSchema } from "@madori/contracts";
import type {
  AcceptedJob,
  AcceptInstructionRequest,
  CreateProjectRequest,
  PatternStateResponse,
  Revision,
} from "@madori/contracts";
import {
  ApiError,
  createProject,
  fetchRevisionView,
  readPatternState,
  sendInstruction,
} from "./api.ts";

export const sampleInstruction = "サンプルの形を作ってください。";
const pollIntervalMs = 1000;
const storageKey = "instant-madori.dev-sample";
type SampleStorage = Pick<Storage, "getItem" | "setItem">;
type Requests = { project: CreateProjectRequest; instruction: AcceptInstructionRequest };
export class SampleStorageError extends Error {}

function parseRequests(raw: string): Requests | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("project" in value) ||
    !("instruction" in value) ||
    Object.keys(value).length !== 2
  )
    return null;
  const project = createProjectRequestSchema.safeParse(value.project);
  const instruction = acceptInstructionRequestSchema.safeParse(value.instruction);
  return project.success && instruction.success
    ? { project: project.data, instruction: instruction.data }
    : null;
}

function newInstruction() {
  return { requestId: crypto.randomUUID(), body: sampleInstruction };
}

function loadOrCreateRequests(storage?: SampleStorage, replaceInstruction = false): Requests {
  try {
    const store = storage ?? globalThis.localStorage;
    const raw = store.getItem(storageKey);
    const saved = raw === null ? null : parseRequests(raw);
    if (saved && !replaceInstruction) return saved;
    const requests = {
      project: saved?.project ?? { requestId: crypto.randomUUID(), name: "開発用サンプル" },
      instruction: newInstruction(),
    };
    store.setItem(storageKey, JSON.stringify(requests));
    return requests;
  } catch {
    throw new SampleStorageError();
  }
}

export function startNewInstruction(storage?: SampleStorage) {
  loadOrCreateRequests(storage, true);
}

type Pending = { kind: "running" } | { kind: "queued"; ahead: number };
type JobProgress =
  | Pending
  | { kind: "missing" }
  | { kind: "done"; revision: Revision }
  | { kind: "stopped" | "failed"; revision: Revision | null };
export function judgeJob(state: PatternStateResponse, job: AcceptedJob): JobProgress {
  const { runningJob, queuedJobs, lastFinishedJob, currentRevision: revision } = state;
  if (runningJob?.jobId === job.jobId) return { kind: "running" };
  const index = queuedJobs.findIndex((queued) => queued.jobId === job.jobId);
  if (index >= 0) return { kind: "queued", ahead: index + (runningJob ? 1 : 0) };
  if (lastFinishedJob?.jobId === job.jobId) {
    switch (lastFinishedJob.state) {
      case "completed":
        return revision ? { kind: "done", revision } : { kind: "missing" };
      case "failed":
        return { kind: "failed", revision };
      case "cancelled":
        return { kind: "stopped", revision };
    }
  }
  if (lastFinishedJob && lastFinishedJob.number > job.number)
    return revision ? { kind: "done", revision } : { kind: "failed", revision: null };
  return { kind: "missing" };
}

export type SampleStep =
  Pending | { kind: "preparing" } | { kind: "loading_view"; revision: Revision };
type RevisionView = { revision: Revision; display: Uint8Array };
export type SampleResult =
  { kind: "done"; view: RevisionView } | { kind: "failed" | "stopped"; view: RevisionView | null };

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(new DOMException("Polling aborted", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function runSample({
  signal,
  onStep,
  storage,
  wait = delay,
}: {
  signal: AbortSignal;
  onStep: (step: SampleStep) => void;
  storage?: SampleStorage;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<SampleResult> {
  signal.throwIfAborted();
  onStep({ kind: "preparing" });
  const requests = loadOrCreateRequests(storage);
  const pattern = await createProject(requests.project, signal);
  const job = await sendInstruction(pattern.id, requests.instruction, signal);
  for (;;) {
    const state = await readPatternState(pattern.id, signal);
    signal.throwIfAborted();
    const progress = judgeJob(state, job);
    if (progress.kind === "missing") throw new ApiError("unexpected_response");
    if (progress.kind === "running" || progress.kind === "queued") {
      onStep(progress);
      await wait(pollIntervalMs, signal);
      continue;
    }
    if (progress.kind === "done") return { kind: "done", view: await loadView(progress.revision) };
    return { kind: progress.kind, view: progress.revision && (await loadView(progress.revision)) };
  }

  async function loadView(revision: Revision): Promise<RevisionView> {
    onStep({ kind: "loading_view", revision });
    return { revision, display: await fetchRevisionView(revision.id, signal) };
  }
}

export function failureMessage(error: unknown): string {
  if (error instanceof SampleStorageError)
    return "ブラウザに保存できないため、サンプルを用意できません。";
  if (error instanceof ApiError) {
    if (error.code === "service_unavailable")
      return "形状サービスを利用できません。しばらくしてから再試行してください。";
    if (error.code === "network") return "通信に失敗しました。接続を確認して再試行してください。";
  }
  return "サンプルの取得に失敗しました。";
}

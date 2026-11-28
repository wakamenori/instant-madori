import type { FloorPlan } from "./floor-plan/plan-svg.ts";
import {
  buildTimeline,
  mergeRows,
  type InstructionBody,
  type TimelineEntry,
  type Outbox,
  type OutboxEntry,
  type ServerRows,
} from "./conversation.ts";
import type { Project, Pattern, PatternStateResponse, Revision } from "@madori/contracts";
import {
  ApiError,
  getProject,
  renameProject,
  renamePattern,
  listPatterns,
  listMessages,
  sendInstruction,
  stopJob,
  resumeQueue,
  cancelQueue,
  readPatternState,
  fetchRevisionView,
  fetchFloorPlan,
} from "./api.ts";
import {
  failureMessage,
  isConnectionFailure,
  renameFailureMessage,
  sendFailureMessage,
} from "./failure.ts";
import {
  describeStatus,
  isWorking,
  type Action,
  type OpenQuestion,
  type Receipt,
  type StatusView,
} from "./pattern-status.ts";
import type { ProjectId } from "./route.ts";

type OperationRequest = { action: Action; requestId: string; closedQuestion: boolean };
type Operation =
  | { phase: "posting"; request: OperationRequest }
  | { phase: "refreshing"; request: OperationRequest; generation: number };
type OperationResult = {
  receipt: Receipt;
  retry: OperationRequest | null;
  signature: string | null;
};

// Newly queued instructions do not supersede a release receipt or its retry.
function progress({ runningJob, queueHold, lastFinishedJob }: PatternStateResponse): string {
  const hold = queueHold?.job;
  return JSON.stringify([
    runningJob?.jobId,
    hold?.jobId,
    hold?.state === "awaiting_answer" ? hold.answer?.jobId : null,
    lastFinishedJob?.jobId,
  ]);
}

async function postOperation(
  patternId: string,
  request: OperationRequest,
  signal: AbortSignal,
): Promise<Receipt> {
  const { action, requestId, closedQuestion } = request;
  if (action.kind === "stop") {
    const result = await stopJob(action.jobId, { requestId }, signal);
    if (result.outcome === "stopped") return { kind: "stopped" };
    const job = result.job;
    return job.state === "completed"
      ? { kind: "finished_first", ending: job.state, revision: job.revision }
      : { kind: "finished_first", ending: job.state };
  }
  const release = action.kind === "resume" ? resumeQueue : cancelQueue;
  const { jobs } = await release(patternId, { requestId, heldBy: action.heldBy }, signal);
  return { kind: "released", how: action.kind, count: jobs.length, closedQuestion };
}

export type PlanSlot =
  { kind: "ready"; plan: FloorPlan } | { kind: "absent" } | { kind: "rejected" };
export type RevisionView = { revision: Revision; display: Uint8Array; plan: PlanSlot };
export type NameTarget = "project" | "pattern";
export type NameStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "conflict"; latestName: string }
  | { kind: "failed"; message: string };

function newer<T extends { version: number }>(current: T | undefined, incoming: T): T {
  return current && current.version >= incoming.version ? current : incoming;
}

export type ProjectView =
  | { kind: "opening" }
  | { kind: "failed"; message: string }
  | { kind: "not_found" }
  | {
      kind: "open";
      project: Project;
      pattern: Pattern;
      names: Record<NameTarget, NameStatus>;
      status: StatusView;
      inputInFlight: boolean;
      shown: RevisionView | null;
      problem: string | null;
      timeline: readonly TimelineEntry[];
    };
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

async function loadRevision(
  revision: Revision | null,
  previous: RevisionView | null,
  signal: AbortSignal,
): Promise<RevisionView | null> {
  if (!revision) return null;
  if (previous?.revision.id === revision.id) return { ...previous, revision };
  const { display, storeys } = await fetchRevisionView(revision.id, signal);
  const storey = storeys[0];
  if (storey === undefined) return { revision, display, plan: { kind: "absent" } };
  const plan = await fetchFloorPlan(revision.id, storey, signal);
  return { revision, display, plan: plan ? { kind: "ready", plan } : { kind: "rejected" } };
}

type Dependencies = { wait?: typeof delay; newRequestId?: () => string; sendTimeoutMs?: number };
export type ProjectSession = {
  readonly start: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getView: () => ProjectView;
  readonly rename: (target: NameTarget, name: string) => Promise<boolean>;
  readonly send: (body: InstructionBody) => void;
  readonly answer: (question: OpenQuestion, body: InstructionBody) => void;
  readonly resend: (requestId: string) => void;
  readonly act: (action: Action) => void;
  readonly retryOperation: () => void;
  readonly retry: () => void;
};

function signature(state: PatternStateResponse) {
  return JSON.stringify([
    state.currentRevision?.id,
    state.runningJob?.jobId,
    state.queuedJobs.map((job) => job.jobId),
    state.queueHold?.job,
    state.lastFinishedJob,
  ]);
}

function wakeLatch(signal: AbortSignal, wait: typeof delay) {
  let pending = false;
  let sleeper: AbortController | null = null;
  return {
    wake() {
      pending = true;
      sleeper?.abort();
    },
    consume() {
      pending = false;
    },
    async sleep(ms: number | null) {
      if (!pending && !signal.aborted) {
        sleeper = new AbortController();
        const interrupted = AbortSignal.any([sleeper.signal, signal]);
        try {
          if (ms === null)
            await new Promise<void>((resolve) =>
              interrupted.addEventListener("abort", () => resolve(), { once: true }),
            );
          else await wait(ms, interrupted);
        } catch (error) {
          if (!interrupted.aborted) throw error;
        } finally {
          sleeper = null;
        }
      }
      pending = false;
    },
  };
}

export function createProjectSession(
  projectId: ProjectId,
  deps: Dependencies = {},
): ProjectSession {
  const listeners = new Set<() => void>();
  let view: ProjectView = { kind: "opening" };
  let state: PatternStateResponse | null = null;
  let rows: ServerRows = new Map();
  let outbox: Outbox = [];
  let project: Project | undefined;
  let names: Record<NameTarget, NameStatus> = {
    project: { kind: "idle" },
    pattern: { kind: "idle" },
  };
  let pattern: Pattern | undefined;
  let generation = 0;
  let publishedGeneration = 0;
  let rereadRequested = true;
  let operation: Operation | null = null;
  let lastResult: OperationResult | null = null;
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());
  let active: { controller: AbortController; latch: ReturnType<typeof wakeLatch> } | null = null;

  function publish(next: ProjectView) {
    view = next;
    for (const listener of listeners) listener();
  }
  function hasInputInFlight() {
    return outbox.some(
      (entry) => entry.delivery.kind === "sending" || entry.generation > publishedGeneration,
    );
  }
  function publishOpen(
    shown = view.kind === "open" ? view.shown : null,
    problem = view.kind === "open" ? view.problem : null,
  ) {
    if (project && pattern && state) {
      const inputInFlight = hasInputInFlight();
      const result = lastResult?.signature === progress(state) ? lastResult : null;
      publish({
        kind: "open",
        project,
        pattern,
        names,
        shown,
        problem,
        inputInFlight,
        status: {
          now: describeStatus(state, { inputInFlight }),
          pending: operation?.request.action.kind ?? null,
          receipt: result?.receipt ?? null,
          canRetry: Boolean(result?.retry),
        },
        timeline: buildTimeline(rows, outbox, state),
      });
    }
  }
  function setNameStatus(target: NameTarget, status: NameStatus) {
    names = { ...names, [target]: status };
    publishOpen();
  }
  async function poll(signal: AbortSignal, latch: ReturnType<typeof wakeLatch>) {
    let rowsSig: string | undefined;
    let backoff = 1000;
    while (!signal.aborted) {
      let startedAt = generation;
      let interval: number | null = 1000;
      try {
        if (!project) {
          const record = await getProject(projectId, signal);
          signal.throwIfAborted();
          project = record;
        }
        if (!pattern) {
          const patterns = await listPatterns(projectId, signal);
          signal.throwIfAborted();
          pattern = patterns[0];
          if (!pattern) throw new ApiError("unexpected_response");
        }
        latch.consume();
        startedAt = generation;
        let latest = await readPatternState(pattern.id, signal);
        signal.throwIfAborted();
        if (startedAt < generation) continue;
        let polledPattern = latest.pattern;
        const sig = signature(latest);
        let updated = rows;
        if (sig !== rowsSig || rereadRequested) {
          rereadRequested = false;
          const page = await listMessages(pattern.id, null, signal);
          updated = mergeRows(rows, page.messages, page.nextCursor);
          if (page.messages.some((message) => !rows.has(message.id))) {
            latest = await readPatternState(pattern.id, signal);
            polledPattern = newer(polledPattern, latest.pattern);
          }
        }
        const shown = await loadRevision(
          latest.currentRevision,
          view.kind === "open" ? view.shown : null,
          signal,
        );
        signal.throwIfAborted();
        if (startedAt < generation) continue;
        pattern = newer(pattern, polledPattern);
        state = latest;
        rows = updated;
        rowsSig = sig;
        publishedGeneration = startedAt;
        if (operation?.phase === "refreshing" && startedAt >= operation.generation) {
          operation = null;
          if (lastResult) lastResult.signature = progress(latest);
        } else if (
          lastResult &&
          lastResult.signature !== null &&
          lastResult.signature !== progress(latest)
        ) {
          lastResult = null;
        }
        publishOpen(shown, null);
        backoff = 1000;
        if (signature(latest) !== rowsSig) continue;
        if (
          view.kind === "open" &&
          !isWorking(view.status.now) &&
          !hasInputInFlight() &&
          operation?.phase !== "refreshing"
        )
          interval = null;
      } catch (error) {
        if (signal.aborted) return;
        if (startedAt < generation) continue;
        if (!pattern && error instanceof ApiError && error.code === "not_found") {
          publish({ kind: "not_found" });
          return;
        }
        rereadRequested = true;
        const message = failureMessage(error);
        if (view.kind === "open") publishOpen(view.shown, message);
        else publish({ kind: "failed", message });
        interval = backoff;
        backoff = Math.min(backoff * 2, 30000);
      }
      await latch.sleep(interval);
    }
  }

  function setDelivery(requestId: string, delivery: OutboxEntry["delivery"]) {
    if (delivery.kind !== "sending") generation++;
    outbox = outbox.map((e) => (e.requestId === requestId ? { ...e, delivery, generation } : e));
    publishOpen();
  }
  let delivering = false;
  async function drain() {
    if (delivering) return;
    delivering = true;
    try {
      while (active && pattern) {
        const entry = outbox.find((e) => e.delivery.kind === "sending");
        if (!entry) return;
        const { requestId, body, questionId } = entry;
        const lifetime = active.controller.signal;
        const signal = AbortSignal.any([
          lifetime,
          AbortSignal.timeout(deps.sendTimeoutMs ?? 15000),
        ]);
        try {
          const job = await sendInstruction(
            pattern.id,
            { requestId, body, questionId: questionId ?? undefined },
            signal,
          );
          lifetime.throwIfAborted();
          setDelivery(requestId, { kind: "accepted", job });
        } catch (error) {
          if (lifetime.aborted) continue;
          const rejected =
            questionId !== null && error instanceof ApiError && error.code === "version_conflict";
          setDelivery(
            requestId,
            rejected
              ? { kind: "rejected" }
              : { kind: "unsent", message: sendFailureMessage(error) },
          );
        }
        rereadRequested = true;
        active?.latch.wake();
      }
    } finally {
      delivering = false;
    }
  }

  let nextSequence = 0;
  function enqueue(body: InstructionBody, questionId: string | null) {
    outbox = [
      ...outbox,
      {
        body,
        questionId,
        requestId: newRequestId(),
        seq: nextSequence++,
        generation,
        delivery: { kind: "sending" },
      },
    ];
    publishOpen();
    void drain();
  }

  async function operate(request: OperationRequest) {
    if (!active || !pattern || operation !== null) return;
    const { controller, latch } = active;
    const lifetime = controller.signal;
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(deps.sendTimeoutMs ?? 15000)]);
    operation = { request, phase: "posting" };
    lastResult = null;
    publishOpen();
    let receipt: Receipt;
    try {
      receipt = await postOperation(pattern.id, request, signal);
    } catch (error) {
      if (lifetime.aborted) return;
      const { kind } = request.action;
      const code = error instanceof ApiError ? error.code : null;
      receipt =
        kind !== "stop" && code === "version_conflict"
          ? { kind: "conflict" }
          : {
              kind: "failed",
              action: kind,
              uncertain:
                isConnectionFailure(error) ||
                code === "internal_error" ||
                code === "unexpected_response",
            };
    }
    if (lifetime.aborted) return;
    operation = { request, phase: "refreshing", generation: ++generation };
    lastResult = {
      receipt,
      retry: receipt.kind === "failed" && receipt.uncertain ? request : null,
      signature: null,
    };
    rereadRequested = true;
    latch.wake();
  }

  return {
    start() {
      active?.controller.abort();
      const controller = new AbortController();
      const latch = wakeLatch(controller.signal, deps.wait ?? delay);
      active = { controller, latch };
      void poll(controller.signal, latch);
      void drain();
      controller.signal.addEventListener(
        "abort",
        () => {
          if (active?.controller !== controller) return;
          active = null;
          if (operation !== null) lastResult = null;
          operation = null;
          for (const target of ["project", "pattern"] as const) {
            if (names[target].kind === "saving") names = { ...names, [target]: { kind: "idle" } };
          }
          outbox = outbox.map((e) =>
            e.delivery.kind === "sending"
              ? {
                  ...e,
                  delivery: {
                    kind: "unsent",
                    message: sendFailureMessage(controller.signal.reason),
                  },
                }
              : e,
          );
          publishOpen();
        },
        { once: true },
      );
      return () => controller.abort();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getView: () => view,
    async rename(target, name) {
      if (!active || view.kind !== "open" || names[target].kind === "saving") return false;
      const record = view[target];
      const lifetime = active.controller.signal;
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(deps.sendTimeoutMs ?? 15000)]);
      const body = {
        requestId: newRequestId(),
        version: record.version,
        name,
      };
      setNameStatus(target, { kind: "saving" });
      try {
        try {
          if (target === "project") {
            const saved = await renameProject(record.id, body, signal);
            signal.throwIfAborted();
            project = newer(project, saved);
          } else {
            const saved = await renamePattern(record.id, body, signal);
            signal.throwIfAborted();
            pattern = newer(pattern, saved);
          }
        } catch (error) {
          if (!(error instanceof ApiError && error.code === "version_conflict")) throw error;
          let latestName: string;
          if (target === "project") {
            const latest = await getProject(record.id, signal);
            signal.throwIfAborted();
            project = newer(project, latest);
            latestName = project.name;
          } else {
            const latest = await readPatternState(record.id, signal);
            signal.throwIfAborted();
            pattern = newer(pattern, latest.pattern);
            latestName = pattern.name;
          }
          if (latestName !== name.trim()) {
            setNameStatus(target, { kind: "conflict", latestName });
            return false;
          }
        }
        setNameStatus(target, { kind: "idle" });
        return true;
      } catch (error) {
        if (!lifetime.aborted)
          setNameStatus(target, { kind: "failed", message: renameFailureMessage(error) });
        return false;
      }
    },
    send(body) {
      if (active && view.kind === "open") enqueue(body, null);
    },
    answer(question, body) {
      if (
        !active ||
        view.kind !== "open" ||
        operation !== null ||
        hasInputInFlight() ||
        view.status.now.kind !== "asking" ||
        view.status.now.question.messageId !== question.messageId
      )
        return;
      enqueue(body, question.messageId);
    },
    resend(requestId) {
      if (!active) return;
      const entry = outbox.find((e) => e.requestId === requestId);
      if (entry?.delivery.kind === "unsent") {
        setDelivery(requestId, { kind: "sending" });
        void drain();
      } else if (entry?.delivery.kind === "rejected") {
        outbox = outbox.filter((e) => e !== entry);
        enqueue(entry.body, null);
      }
    },
    act(action) {
      if (!active || view.kind !== "open" || operation !== null) return;
      if (action.kind !== "stop" && hasInputInFlight()) return;
      const closedQuestion = action.kind !== "stop" && view.status.now.kind === "asking";
      void operate({ action, requestId: newRequestId(), closedQuestion });
    },
    retryOperation() {
      if (view.kind !== "open" || !view.status.canRetry || !lastResult?.retry) return;
      if (lastResult.retry.action.kind !== "stop" && hasInputInFlight()) return;
      void operate(lastResult.retry);
    },
    retry() {
      rereadRequested = true;
      active?.latch.wake();
    },
  };
}

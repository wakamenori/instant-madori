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
import type {
  Project,
  Pattern,
  HoldingJob,
  PatternStateResponse,
  Revision,
} from "@madori/contracts";
import {
  ApiError,
  getProject,
  renameProject,
  renamePattern,
  listPatterns,
  listMessages,
  sendInstruction,
  readPatternState,
  fetchRevisionView,
  fetchFloorPlan,
} from "./api.ts";
import { failureMessage, renameFailureMessage, sendFailureMessage } from "./failure.ts";
import type { ProjectId } from "./route.ts";
type Activity =
  | { kind: "working"; queued: number }
  | { kind: "queued"; count: number }
  | { kind: "held"; job: HoldingJob; queued: number }
  | { kind: "idle" };
export function summarizeActivity({
  runningJob,
  queueHold,
  queuedJobs,
}: PatternStateResponse): Activity {
  const queued = queuedJobs.length;
  if (queueHold) return { kind: "held", job: queueHold.job, queued };
  if (runningJob) return { kind: "working", queued };
  if (queued) return { kind: "queued", count: queued };
  return { kind: "idle" };
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
      activity: Activity;
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
  readonly resend: (requestId: string) => void;
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
  let rereadRequested = true;
  let active: { controller: AbortController; latch: ReturnType<typeof wakeLatch> } | null = null;

  function publish(next: ProjectView) {
    view = next;
    for (const listener of listeners) listener();
  }
  function publishOpen(
    shown = view.kind === "open" ? view.shown : null,
    problem = view.kind === "open" ? view.problem : null,
  ) {
    if (project && pattern && state)
      publish({
        kind: "open",
        project,
        pattern,
        names,
        shown,
        problem,
        activity: summarizeActivity(state),
        timeline: buildTimeline(rows, outbox, state),
      });
  }
  function setNameStatus(target: NameTarget, status: NameStatus) {
    names = { ...names, [target]: status };
    publishOpen();
  }
  async function poll(signal: AbortSignal, latch: ReturnType<typeof wakeLatch>) {
    let rowsSig: string | undefined;
    let backoff = 1000;
    while (!signal.aborted) {
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
        let latest = await readPatternState(pattern.id, signal);
        let polledPattern = latest.pattern;
        const sig = signature(latest);
        let updated = rows;
        signal.throwIfAborted();
        if (sig !== rowsSig || rereadRequested) {
          rereadRequested = false;
          const page = await listMessages(pattern.id, null, signal);
          updated = mergeRows(rows, page.messages);
          if (updated.size > rows.size) {
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
        pattern = newer(pattern, polledPattern);
        state = latest;
        rows = updated;
        rowsSig = sig;
        const activity = summarizeActivity(state);
        publishOpen(shown, null);
        backoff = 1000;
        if (
          (activity.kind === "idle" || activity.kind === "held") &&
          signature(state) === rowsSig &&
          outbox.every((e) => e.delivery.kind !== "accepted" || rows.has(e.delivery.job.messageId))
        )
          interval = null;
      } catch (error) {
        if (signal.aborted) return;
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
    outbox = outbox.map((e) => (e.requestId === requestId ? { ...e, delivery } : e));
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
        const { requestId, body } = entry;
        const lifetime = active.controller.signal;
        const signal = AbortSignal.any([
          lifetime,
          AbortSignal.timeout(deps.sendTimeoutMs ?? 15000),
        ]);
        try {
          const job = await sendInstruction(pattern.id, { requestId, body }, signal);
          setDelivery(requestId, { kind: "accepted", job });
        } catch (error) {
          if (!lifetime.aborted)
            setDelivery(requestId, { kind: "unsent", message: sendFailureMessage(error) });
        }
        rereadRequested = true;
        active?.latch.wake();
      }
    } finally {
      delivering = false;
    }
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
        requestId: deps.newRequestId?.() ?? crypto.randomUUID(),
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
      if (!active || view.kind !== "open") return;
      outbox = [
        ...outbox,
        {
          body,
          requestId: deps.newRequestId?.() ?? crypto.randomUUID(),
          seq: outbox.length,
          delivery: { kind: "sending" },
        },
      ];
      publishOpen();
      void drain();
    },
    resend(requestId) {
      if (!active || outbox.find((e) => e.requestId === requestId)?.delivery.kind !== "unsent")
        return;
      setDelivery(requestId, { kind: "sending" });
      void drain();
    },
    retry() {
      rereadRequested = true;
      active?.latch.wake();
    },
  };
}

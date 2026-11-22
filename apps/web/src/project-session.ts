import type { Pattern, HoldingJob, PatternStateResponse, Revision } from "@madori/contracts";
import { ApiError, listPatterns, readPatternState, fetchRevisionView } from "./api.ts";
import { failureMessage } from "./failure.ts";
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
type RevisionView = { revision: Revision; display: Uint8Array };
export type ProjectView =
  | { kind: "opening" }
  | { kind: "failed"; message: string }
  | { kind: "not_found" }
  | {
      kind: "open";
      pattern: Pattern;
      activity: Activity;
      shown: RevisionView | null;
      problem: string | null;
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
  const display =
    previous?.revision.id === revision.id
      ? previous.display
      : await fetchRevisionView(revision.id, signal);
  return { revision, display };
}

export async function watchProject({
  projectId,
  signal,
  onView,
  wait = delay,
}: {
  projectId: ProjectId;
  signal: AbortSignal;
  onView: (view: ProjectView) => void;
  wait?: typeof delay;
}): Promise<void> {
  let last: Extract<ProjectView, { kind: "open" }> | undefined;
  try {
    const patterns = await listPatterns(projectId, signal).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "not_found") return null;
      throw error;
    });
    signal.throwIfAborted();
    if (patterns === null) {
      onView({ kind: "not_found" });
      return;
    }
    const pattern = patterns[0];
    if (!pattern) throw new ApiError("unexpected_response");

    for (;;) {
      const state = await readPatternState(pattern.id, signal);
      const shown: RevisionView | null = await loadRevision(
        state.currentRevision,
        last?.shown ?? null,
        signal,
      );
      signal.throwIfAborted();
      const activity = summarizeActivity(state);
      last = { kind: "open", pattern, shown, activity, problem: null };
      onView(last);
      if (activity.kind === "idle" || activity.kind === "held") return;
      await wait(1000, signal);
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = failureMessage(error);
    onView(last ? { ...last, problem: message } : { kind: "failed", message });
  }
}

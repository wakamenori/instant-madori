import type { PatternStateResponse, Revision } from "@madori/contracts";

declare const actionBrand: unique symbol;
export type Action = (
  | { readonly kind: "stop"; readonly jobId: string }
  | { readonly kind: "resume" | "cancel"; readonly heldBy: string }
) & { readonly [actionBrand]: true };
export type ReleaseActions = {
  readonly resume: Action & { kind: "resume" };
  readonly cancel: Action & { kind: "cancel" };
};

declare const questionBrand: unique symbol;
export type OpenQuestion = {
  readonly messageId: string;
  readonly body: string;
  readonly choices: readonly string[];
} & { readonly [questionBrand]: true };

export type Ending = "completed" | "cancelled" | "failed" | "limited";
export type HoldCause =
  | { readonly kind: "stopped" | "failed" | "limited" }
  | {
      readonly kind: "answered";
      readonly ending: Ending | null;
      readonly revision: Revision | null;
    };
export type LastOutcome = { readonly kind: "cancelled" | "failed" | "limited" } | null;

export type PatternStatus =
  | { readonly kind: "idle"; readonly last: LastOutcome }
  | { readonly kind: "starting"; readonly waiting: number }
  | { readonly kind: "running"; readonly waiting: number; readonly stop: Action | null }
  | {
      readonly kind: "asking";
      readonly question: OpenQuestion;
      readonly held: number;
      readonly release: ReleaseActions | null;
    }
  | { readonly kind: "answering"; readonly held: number; readonly stop: Action | null }
  | {
      readonly kind: "held";
      readonly cause: HoldCause;
      readonly held: number;
      readonly release: ReleaseActions | null;
    };

export type Receipt =
  | { readonly kind: "stopped" }
  | { readonly kind: "finished_first"; readonly ending: "completed"; readonly revision: Revision }
  | {
      readonly kind: "finished_first";
      readonly ending: "cancelled" | "failed" | "limited" | "awaiting_answer";
    }
  | {
      readonly kind: "released";
      readonly how: "resume" | "cancel";
      readonly count: number;
      readonly closedQuestion: boolean;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed"; readonly action: Action["kind"]; readonly uncertain: boolean };

export type StatusView = {
  readonly now: PatternStatus;
  readonly pending: Action["kind"] | null;
  readonly receipt: Receipt | null;
  readonly canRetry: boolean;
};

function stop(jobId: string): Action {
  return { kind: "stop", jobId } as Action;
}

function release(heldBy: string): ReleaseActions {
  return {
    resume: { kind: "resume", heldBy } as ReleaseActions["resume"],
    cancel: { kind: "cancel", heldBy } as ReleaseActions["cancel"],
  };
}

export function describeStatus(
  state: PatternStateResponse,
  { inputInFlight }: { inputInFlight: boolean },
): PatternStatus {
  const { runningJob, queuedJobs, lastFinishedJob } = state;
  const hold = state.queueHold?.job;
  const answer = hold?.state === "awaiting_answer" ? hold.answer : null;
  const held = queuedJobs.filter((job) => job.jobId !== answer?.jobId).length;

  if (answer) {
    if (runningJob?.jobId === answer.jobId)
      return { kind: "answering", held, stop: stop(answer.jobId) };
    if (queuedJobs.some((job) => job.jobId === answer.jobId))
      return { kind: "answering", held, stop: null };
  }
  if (runningJob)
    return { kind: "running", waiting: queuedJobs.length, stop: stop(runningJob.jobId) };
  if (hold) {
    const actions = inputInFlight ? null : release(hold.jobId);
    if (hold.state === "awaiting_answer") {
      if (!hold.answer) {
        const { messageId, body, choices } = hold.question;
        const question: Omit<OpenQuestion, typeof questionBrand> = { messageId, body, choices };
        return {
          kind: "asking",
          question: question as OpenQuestion,
          held,
          release: held > 0 ? actions : null,
        };
      }
      const finished = lastFinishedJob?.jobId === hold.answer.jobId ? lastFinishedJob : null;
      return {
        kind: "held",
        held,
        release: actions,
        cause: {
          kind: "answered",
          ending: finished?.state === "awaiting_answer" ? null : (finished?.state ?? null),
          revision: finished?.state === "completed" ? finished.revision : null,
        },
      };
    }
    return {
      kind: "held",
      cause: { kind: hold.state === "cancelled" ? "stopped" : hold.state },
      held,
      release: actions,
    };
  }
  if (queuedJobs.length > 0) return { kind: "starting", waiting: queuedJobs.length };
  const last = lastFinishedJob?.state;
  return {
    kind: "idle",
    last: last === "cancelled" || last === "failed" || last === "limited" ? { kind: last } : null,
  };
}

export function isWorking(status: PatternStatus): boolean {
  return status.kind === "running" || status.kind === "starting" || status.kind === "answering";
}

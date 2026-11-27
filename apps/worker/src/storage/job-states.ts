import { z } from "zod";

export const jobStateSchema = z.enum([
  "queued",
  "running",
  "validating",
  "committing",
  "completed",
  "awaiting_answer",
  "cancelled",
  "failed",
  "limited",
]);
export type JobState = z.infer<typeof jobStateSchema>;

const jobStateRoles = {
  queued: "waiting",
  running: "active",
  validating: "active",
  committing: "active",
  completed: "completed",
  awaiting_answer: "finished",
  cancelled: "finished",
  failed: "finished",
  limited: "unwritten",
} as const satisfies Record<
  JobState,
  "waiting" | "active" | "completed" | "finished" | "unwritten"
>;

function statesWithRoles(...roles: (typeof jobStateRoles)[JobState][]) {
  return jobStateSchema.options
    .filter((state) => roles.includes(jobStateRoles[state]))
    .map((state) => `'${state}'`)
    .join(", ");
}

export const activeJobStates = statesWithRoles("active");
export const stoppableJobStates = statesWithRoles("waiting", "active");
export const finishedJobStates = statesWithRoles("completed", "finished");
export const holdingJobStates = statesWithRoles("finished", "unwritten");

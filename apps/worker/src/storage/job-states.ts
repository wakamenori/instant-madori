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
  completed: "finished",
  awaiting_answer: "unwritten",
  cancelled: "finished",
  failed: "finished",
  limited: "unwritten",
} as const satisfies Record<JobState, "waiting" | "active" | "finished" | "unwritten">;

function statesWithRoles(...roles: (typeof jobStateRoles)[JobState][]) {
  return jobStateSchema.options
    .filter((state) => roles.includes(jobStateRoles[state]))
    .map((state) => `'${state}'`)
    .join(", ");
}

export const activeJobStates = statesWithRoles("active");
export const stoppableJobStates = statesWithRoles("waiting", "active");
export const finishedJobStates = statesWithRoles("finished");

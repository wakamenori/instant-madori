import type { JobExecutionReference, JobExecutionRight } from "../storage/job-execution.ts";
import type { AiCostDeps } from "./deps.ts";
import type { AiRequest, Usage } from "../ai/round-trip.ts";
import type { limits } from "../limits.ts";
import {
  estimateAttempt,
  settleAttempt,
  type AttemptEstimate,
  type AttemptCharge,
} from "./cost.ts";

interface ReservedAttempt {
  readonly id: string;
  readonly job: JobExecutionReference;
  readonly estimate: AttemptEstimate;
}

export async function reserveAttemptCost(
  deps: AiCostDeps,
  input: { right: JobExecutionRight; request: AiRequest },
): Promise<
  | { kind: "reserved"; attempt: ReservedAttempt }
  | { kind: "limited"; limit: keyof typeof limits.aiCost }
  | { kind: "execution_lost" }
> {
  const estimate = estimateAttempt(input.request);
  const id = deps.runtime.newId();
  const result = await deps.store.aiCost.reserve(input.right, {
    attemptId: id,
    reserve: estimate.reserve,
    estimatedInputTokens: estimate.inputTokens,
    estimatedOutputTokens: estimate.outputTokens,
    now: deps.runtime.now(),
  });
  if (result.kind !== "reserved") return result;
  return { kind: "reserved", attempt: { id, job: input.right.reference, estimate } };
}

export async function settleAttemptCost(
  deps: AiCostDeps,
  { attempt, usage }: { attempt: ReservedAttempt; usage: Usage },
): Promise<AttemptCharge> {
  const charge = settleAttempt(attempt.estimate, usage);
  await deps.store.aiCost.settle(attempt.job, {
    attemptId: attempt.id,
    charge: charge.amount,
    usage,
    now: deps.runtime.now(),
  });
  return charge;
}

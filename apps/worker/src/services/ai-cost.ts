import type { JobExecutionRight } from "../storage/job-execution.ts";
import type { AiCostDeps } from "./deps.ts";
import type { Ai, AiRequest, AiResult } from "../ai/round-trip.ts";
import type { limits } from "../limits.ts";
import { estimateAttempt, settleAttempt } from "./cost.ts";

export type AiCostLimit = keyof typeof limits.aiCost;
type AiFailure = Extract<AiResult, { kind: "failed" }>;
const settlesAtZero = { no_provider: true, script_ended: true, rejected: true } satisfies Record<
  AiFailure["reason"],
  boolean
>;

export async function meteredRoundTrip(
  deps: AiCostDeps & { ai: Ai },
  right: JobExecutionRight,
  request: AiRequest,
): Promise<AiResult | { kind: "limited"; limit: AiCostLimit } | { kind: "execution_lost" }> {
  const estimate = estimateAttempt(request);
  const attemptId = deps.runtime.newId();
  const result = await deps.store.aiCost.reserve(right, {
    attemptId,
    reserve: estimate.reserve,
    estimatedInputTokens: estimate.inputTokens,
    estimatedOutputTokens: estimate.outputTokens,
    now: deps.runtime.now(),
  });
  if (result.kind !== "reserved") return result;
  const response = await deps.ai.roundTrip(request);
  if (response.kind === "failed" && !settlesAtZero[response.reason]) return response;
  const usage =
    response.kind === "ok"
      ? response.assistant.usage
      : {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        };
  await deps.store.aiCost.settle(right.reference, {
    attemptId,
    charge: settleAttempt(estimate, usage).amount,
    usage,
    now: deps.runtime.now(),
  });
  return response;
}

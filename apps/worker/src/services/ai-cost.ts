import type { JobExecutionRight } from "../storage/job-execution.ts";
import type { AiCostDeps } from "./deps.ts";
import type { Ai, AiRequest, AiResult, Usage } from "../ai/round-trip.ts";
import type { limits } from "../limits.ts";
import { describeError, logEvent } from "../log.ts";
import { estimateAttempt, settleAttempt } from "./cost.ts";

export type AiCostLimit = keyof typeof limits.aiCost;
type AiFailure = Extract<AiResult, { kind: "failed" }>;

const zeroUsage: Usage = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};
const failureUsage = {
  rejected: () => zeroUsage,
  script_ended: () => zeroUsage,
  no_provider: () => zeroUsage,
  unusable: (response) => response.usage,
} satisfies {
  [Reason in AiFailure["reason"]]: (response: AiFailure & { reason: Reason }) => Usage;
};

export async function meteredRoundTrip(
  deps: AiCostDeps & { ai: Ai },
  right: JobExecutionRight,
  request: AiRequest,
): Promise<AiResult | { kind: "limited"; limit: AiCostLimit } | { kind: "execution_lost" }> {
  const estimate = estimateAttempt(request);
  const attemptId = deps.runtime.newId();
  const now = deps.runtime.now();
  const { jobId, generation } = right.reference;
  const fields = { jobId, generation, attemptId, reservedMicroUsd: estimate.reserve };
  const elapsed = () => Date.parse(deps.runtime.now()) - Date.parse(now);

  const result = await deps.store.aiCost.reserve(right, {
    attemptId,
    reserve: estimate.reserve,
    estimatedInputTokens: estimate.inputTokens,
    estimatedOutputTokens: estimate.outputTokens,
    now,
  });
  if (result.kind !== "reserved") {
    logEvent("info", "ai.attempt", { ...fields, aiMs: elapsed(), outcome: result.kind });
    return result;
  }
  try {
    const response = await deps.ai.roundTrip(request);
    const usage =
      response.kind === "ok"
        ? response.assistant.usage
        : response.reason === "unusable"
          ? failureUsage.unusable(response)
          : failureUsage[response.reason]();
    const charged = settleAttempt(estimate, usage).amount;
    await deps.store.aiCost.settle(right.reference, {
      attemptId,
      charge: charged,
      usage,
      now: deps.runtime.now(),
    });
    logEvent("info", "ai.attempt", {
      ...fields,
      ...usage,
      aiMs: elapsed(),
      outcome: "settled",
      chargedMicroUsd: charged,
    });
    return response;
  } catch (error) {
    logEvent("error", "ai.attempt", {
      ...fields,
      aiMs: elapsed(),
      outcome: "unsettled",
      error: describeError(error),
    });
    throw error;
  }
}

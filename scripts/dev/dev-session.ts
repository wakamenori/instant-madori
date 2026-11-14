import { cleanupSteps } from "../shared/processes.ts";
import type { ProcessOutcome } from "../shared/processes.ts";

export async function finishDevelopment(
  result: ProcessOutcome,
  stoppedByUser: boolean,
  stop: () => void | Promise<void>,
): Promise<void> {
  // Fix the outcome before shutdown can fail or receive another interrupt.
  process.exitCode = stoppedByUser ? 0 : result.kind === "error" ? 1 : (result.code ?? 1);
  if (result.kind === "error") console.error(result.error);
  for (const error of await cleanupSteps([stop])) console.error(error);
}

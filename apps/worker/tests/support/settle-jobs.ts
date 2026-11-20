import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { patternStateResponseSchema } from "@madori/contracts";
import type { AccessUser } from "../../../../scripts/dev/local-access.ts";
import type { LocalWorker } from "./local-worker.ts";

export async function settleJobs(
  worker: LocalWorker,
  as: AccessUser,
  patternId: string,
  jobIds: readonly string[],
  timeoutMs = 30_000,
  options: { resumeHolds?: boolean } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const response = await worker.call(`/api/patterns/${patternId}/state`, { as });
    assert.equal(response.status, 200);
    const state = patternStateResponseSchema.parse(await response.json());
    if (state.queueHold) {
      const heldBy = state.queueHold.job.jobId;
      assert(options.resumeHolds, `Queue for ${patternId} is held by ${heldBy}`);
      const resumed = await worker.call(`/api/patterns/${patternId}/queue/resume`, {
        method: "POST",
        as,
        body: { requestId: crypto.randomUUID(), heldBy },
      });
      assert.equal(resumed.status, 200);
    }
    const finished = new Set(
      worker
        .logEntries()
        .filter((line) => line["event"] === "job.finished")
        .map((line) => line["jobId"]),
    );
    if (
      state.runningJob === null &&
      state.queuedJobs.length === 0 &&
      jobIds.every((id) => finished.has(id))
    )
      return state;
    await setTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(
    `Jobs did not finish for ${patternId}: ${JSON.stringify(worker.logEntries().filter((line) => line["patternId"] === patternId))}`,
  );
}

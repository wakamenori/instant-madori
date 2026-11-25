import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  patternStateResponseSchema,
  stopJobResponseSchema,
  revisionListResponseSchema,
  accessAssertionHeader,
} from "@madori/contracts";
import type { PatternStateResponse } from "@madori/contracts";
import { newUser, startLocalWorker, testAppOrigin } from "./support/local-worker.ts";
import { signAccessToken } from "../../../scripts/dev/local-access.ts";
import { settleJobs } from "./support/settle-jobs.ts";

await test("Job stop through workerd HTTP", { timeout: 120_000 }, async (t) => {
  const worker = await startLocalWorker({ vars: { JOB_TEST_HOLD: "before_render:10" } });
  t.after(() => worker.stop());
  const owner = newUser("stop-owner");
  const other = newUser("stop-other");
  async function create() {
    const response = await worker.call("/api/projects", {
      as: owner,
      method: "POST",
      body: { requestId: crypto.randomUUID() },
    });
    assert.equal(response.status, 201);
    return createProjectResponseSchema.parse(await response.json()).pattern;
  }
  async function accept(patternId: string) {
    const response = await worker.call(`/api/patterns/${patternId}/messages`, {
      as: owner,
      method: "POST",
      body: { requestId: crypto.randomUUID(), body: "作って" },
    });
    assert.equal(response.status, 202);
    return acceptInstructionResponseSchema.parse(await response.json()).job;
  }
  async function state(patternId: string) {
    const response = await worker.call(`/api/patterns/${patternId}/state`, { as: owner });
    assert.equal(response.status, 200);
    return patternStateResponseSchema.parse(await response.json());
  }
  async function waitState(patternId: string, ready: (value: PatternStateResponse) => boolean) {
    for (let i = 0; i < 200; i++) {
      const value = await state(patternId);
      if (ready(value)) return value;
      await setTimeout(50);
    }
    throw new Error("Expected job state did not arrive");
  }
  const stop = (jobId: string, requestId = crypto.randomUUID()) =>
    worker.call(`/api/jobs/${jobId}/stop`, { as: owner, method: "POST", body: { requestId } });
  async function error(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const pattern = await create();
  const a = await accept(pattern.id);
  const held = await worker.logLine(a.jobId, "job.step");
  assert.equal(held["step"], "check test hold before render");
  assert.equal(held["outcome"], "hold");
  const b = await accept(pattern.id);
  await waitState(
    pattern.id,
    (value) => value.runningJob?.jobId === a.jobId && value.queuedJobs[0]?.jobId === b.jobId,
  );

  await t.test("authentication, origin, input and ownership guard stops", async () => {
    const path = `/api/jobs/${b.jobId}/stop`;
    const body = { requestId: crypto.randomUUID() };
    await error(await worker.call(path, { method: "POST", body }), 401, "unauthenticated");
    const token = await signAccessToken(worker.key, owner);
    const raw = (text: string, headers = {}) =>
      fetch(`${worker.origin}${path}`, {
        method: "POST",
        headers: {
          origin: testAppOrigin,
          "content-type": "application/json",
          [accessAssertionHeader]: token,
          ...headers,
        },
        body: text,
      });
    await error(
      await raw(JSON.stringify(body), { [accessAssertionHeader]: "invalid" }),
      401,
      "unauthenticated",
    );
    for (const origin of [null, "https://foreign.test"])
      await error(
        await worker.call(path, { method: "POST", as: owner, origin, body }),
        403,
        "forbidden",
      );
    await error(await worker.call(path, { method: "POST", as: other, body }), 404, "not_found");
    for (const id of ["not-a-uuid", crypto.randomUUID()])
      await error(await stop(id), 404, "not_found");
    for (const invalid of [{}, { requestId: "bad" }, { ...body, extra: true }, null])
      await error(
        await worker.call(path, { method: "POST", as: owner, body: invalid }),
        400,
        "invalid_request",
      );
    await error(await raw("{"), 400, "invalid_request");
    await error(
      await raw(JSON.stringify(body), { "content-type": "text/plain" }),
      400,
      "invalid_request",
    );
    await error(await raw(JSON.stringify(body).padEnd(16385, " ")), 413, "payload_too_large");
  });
  await t.test(
    "queued stop replays bytes, reserves its ID and never starts a Workflow",
    async () => {
      const requestId = crypto.randomUUID();
      const first = await stop(b.jobId, requestId);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("cache-control"), "no-store");
      const text = await first.text();
      assert.deepEqual(stopJobResponseSchema.parse(JSON.parse(text)), {
        outcome: "stopped",
        job: { ...b, state: "cancelled" },
      });
      const replay = await stop(b.jobId, requestId);
      assert.equal(replay.status, 200);
      assert.equal(await replay.text(), text);
      for (const [response, record] of [
        [first, "applied"],
        [replay, "replayed"],
      ] as const) {
        const trace = response.headers.get("x-trace-id");
        assert(trace);
        const line = await worker.logLine(trace);
        assert.equal(line["stop"], record);
        assert.equal(line["outcome"], "stopped");
        assert.equal(line["jobState"], "cancelled");
        assert.equal(line["patternId"], pattern.id);
        assert.equal(line["jobId"], b.jobId);
      }
      await error(await stop(a.jobId, requestId), 422, "request_id_reused");
      const finishedId = crypto.randomUUID();
      const finished = await stop(b.jobId, finishedId);
      assert.equal(finished.status, 200);
      const finishedText = await finished.text();
      assert.deepEqual(JSON.parse(finishedText), {
        outcome: "already_finished",
        job: { ...b, state: "cancelled" },
      });
      await error(await stop(a.jobId, finishedId), 422, "request_id_reused");
      assert.equal(await (await stop(b.jobId, finishedId)).text(), finishedText);
      const after = await state(pattern.id);
      assert.deepEqual(after.queuedJobs, []);
      assert.equal(after.lastFinishedJob, null);
    },
  );
  await t.test(
    "running stop holds the queue; resume starts the next before the held Workflow finishes",
    async () => {
      const c = await accept(pattern.id);
      const stopped = await stop(a.jobId);
      assert.equal(stopped.status, 200);
      assert.deepEqual(await stopped.json(), {
        outcome: "stopped",
        job: { ...a, state: "cancelled" },
      });
      const waiting = await waitState(pattern.id, () =>
        worker
          .logEntries()
          .some(
            (line) =>
              line["event"] === "pattern.advanced" &&
              line["outcome"] === "queue_held" &&
              line["heldBy"] === a.jobId,
          ),
      );
      assert.deepEqual(waiting.queueHold, { job: { ...a, state: "cancelled" } });
      assert.deepEqual(waiting.queuedJobs, [c]);
      assert.equal(waiting.runningJob, null);
      assert(
        !worker
          .logEntries()
          .some((line) => line["event"] === "job.step" && line["jobId"] === c.jobId),
      );
      const resume = await worker.call(`/api/patterns/${pattern.id}/queue/resume`, {
        as: owner,
        method: "POST",
        body: { heldBy: a.jobId, requestId: crypto.randomUUID() },
      });
      assert.equal(resume.status, 200);
      await waitState(pattern.id, (value) => value.runningJob?.jobId === c.jobId);
      assert(
        !worker
          .logEntries()
          .some((line) => line["event"] === "job.finished" && line["jobId"] === a.jobId),
      );
      const isolated = await create();
      const d = await accept(isolated.id);
      await waitState(isolated.id, (value) => value.runningJob?.jobId === d.jobId);
      await stop(d.jobId);
      assert.deepEqual((await state(isolated.id)).lastFinishedJob, { ...d, state: "cancelled" });
      await settleJobs(worker, owner, isolated.id, [d.jobId]);
      await stop(c.jobId);
      await settleJobs(worker, owner, pattern.id, [a.jobId, c.jobId]);
      const line = await worker.logLine(a.jobId, "job.finished");
      assert.equal(line["level"], "info");
      assert.equal(line["outcome"], "cancelled");
      assert.equal(line["reason"], undefined);
      assert(
        !worker
          .logEntries()
          .some(
            (line) =>
              line["jobId"] === b.jobId &&
              ["job.step", "job.finished", "pattern.advanced"].includes(String(line["event"])),
          ),
      );
      const response = await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: owner });
      assert.deepEqual(revisionListResponseSchema.parse(await response.json()), {
        revisions: [],
        nextCursor: null,
      });
    },
  );
  await t.test(
    "lastFinishedJob names the last job that ran, not a job stopped before it ran",
    async () => {
      const first = await create();
      const firstA = await accept(first.id);
      await waitState(first.id, (value) => value.runningJob?.jobId === firstA.jobId);
      const firstB = await accept(first.id);
      const firstQueue = await waitState(first.id, (value) => value.queuedJobs.length === 1);
      assert.deepEqual(firstQueue.queuedJobs, [firstB]);
      assert.equal((await stop(firstB.jobId)).status, 200);
      const stoppedB = await state(first.id);
      assert.equal((await stop(firstA.jobId)).status, 200);
      const stoppedFirstA = await state(first.id);
      assert.equal(stoppedFirstA.queueHold, null);

      const second = await create();
      const secondA = await accept(second.id);
      await waitState(second.id, (value) => value.runningJob?.jobId === secondA.jobId);
      const secondB = await accept(second.id);
      const secondC = await accept(second.id);
      const secondQueue = await waitState(second.id, (value) => value.queuedJobs.length === 2);
      assert.deepEqual(secondQueue.queuedJobs, [secondB, secondC]);
      assert.equal((await stop(secondC.jobId)).status, 200);
      assert.equal((await stop(secondA.jobId)).status, 200);
      const heldQueue = await state(second.id);
      const cancelledA = { ...secondA, state: "cancelled" };
      assert.deepEqual(heldQueue.queueHold, { job: cancelledA });
      const cancel = await worker.call(`/api/patterns/${second.id}/queue/cancel`, {
        as: owner,
        method: "POST",
        body: { requestId: crypto.randomUUID(), heldBy: secondA.jobId },
      });
      assert.equal(cancel.status, 200);
      const cancelledQueue = await state(second.id);
      assert.equal(cancelledQueue.queueHold, null);
      assert.deepEqual(cancelledQueue.queuedJobs, []);
      await settleJobs(worker, owner, first.id, [firstA.jobId]);
      await settleJobs(worker, owner, second.id, [secondA.jobId]);
      assert.deepEqual(
        [
          stoppedB.lastFinishedJob,
          stoppedFirstA.lastFinishedJob,
          heldQueue.lastFinishedJob,
          cancelledQueue.lastFinishedJob,
        ],
        [null, { ...firstA, state: "cancelled" }, cancelledA, cancelledA],
      );
    },
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  patternStateResponseSchema,
  cancelQueueResponseSchema,
  resumeQueueResponseSchema,
  accessAssertionHeader,
} from "@madori/contracts";
import type { PatternStateResponse } from "@madori/contracts";
import { newUser, startLocalWorker, testAppOrigin } from "./support/local-worker.ts";
import { signAccessToken } from "../../../scripts/dev/local-access.ts";
import { settleJobs } from "./support/settle-jobs.ts";

await test("Queue hold through workerd HTTP", { timeout: 120_000 }, async (t) => {
  const worker = await startLocalWorker({ vars: { JOB_TEST_HOLD: "before_render:3" } });
  t.after(() => worker.stop());
  const owner = newUser("queue-owner");
  const other = newUser("queue-other");
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
    throw new Error("Expected held queue state did not arrive");
  }
  const stop = (jobId: string, requestId = crypto.randomUUID()) =>
    worker.call(`/api/jobs/${jobId}/stop`, { as: owner, method: "POST", body: { requestId } });
  async function error(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const release = (
    patternId: string,
    action: "resume" | "cancel",
    heldBy: string,
    requestId = crypto.randomUUID(),
  ) =>
    worker.call(`/api/patterns/${patternId}/queue/${action}`, {
      as: owner,
      method: "POST",
      body: { heldBy, requestId },
    });
  async function waiting(count: number) {
    const { id } = await create();
    const a = await accept(id);
    await worker.logLine(a.jobId, "job.step");
    const followers: Awaited<ReturnType<typeof accept>>[] = [];
    for (let i = 0; i < count; i++) followers.push(await accept(id));
    await worker.logLine(a.jobId, "job.finished");
    const held = await waitState(id, (value) => {
      assert.equal(
        value.runningJob,
        null,
        "a failed instruction must hold waiting jobs until release",
      );
      return worker
        .logEntries()
        .some(
          (line) =>
            line["event"] === "pattern.advanced" &&
            line["outcome"] === "queue_held" &&
            line["heldBy"] === a.jobId,
        );
    });
    assert.deepEqual(held.queueHold, { job: { ...a, state: "failed" } });
    assert.equal(held.runningJob, null);
    assert.deepEqual(held.queuedJobs, followers);
    assert(
      !worker
        .logEntries()
        .some(
          (line) =>
            line["event"] === "job.step" && followers.some((job) => job.jobId === line["jobId"]),
        ),
    );
    return { id, a, followers };
  }
  await t.test(
    "failure holds followers until an authenticated resume, including byte-identical replays",
    async () => {
      const { id, a, followers } = await waiting(1);
      const [b] = followers;
      assert(b);
      for (const action of ["resume", "cancel"] as const) {
        const path = `/api/patterns/${id}/queue/${action}`;
        const body = { requestId: crypto.randomUUID(), heldBy: a.jobId };
        await error(await worker.call(path, { method: "POST", body }), 401, "unauthenticated");
        for (const origin of [null, "https://foreign.test"])
          await error(
            await worker.call(path, { as: owner, method: "POST", body, origin }),
            403,
            "forbidden",
          );
        await error(await worker.call(path, { as: other, method: "POST", body }), 404, "not_found");
        for (const unknown of ["bad", crypto.randomUUID()])
          await error(await release(unknown, action, a.jobId), 404, "not_found");
        for (const invalid of [
          null,
          {},
          { requestId: body.requestId },
          { ...body, heldBy: "bad" },
          { ...body, extra: 1 },
        ])
          await error(
            await worker.call(path, { as: owner, method: "POST", body: invalid }),
            400,
            "invalid_request",
          );
        const token = await signAccessToken(worker.key, owner);
        const raw = (value: string, type = "application/json") =>
          fetch(`${worker.origin}${path}`, {
            method: "POST",
            headers: {
              origin: testAppOrigin,
              [accessAssertionHeader]: token,
              "content-type": type,
            },
            body: value,
          });
        await error(await raw("{"), 400, "invalid_request");
        await error(await raw(JSON.stringify(body), "text/plain"), 400, "invalid_request");
        await error(await raw(JSON.stringify(body).padEnd(16385, " ")), 413, "payload_too_large");
        await error(await release(id, action, b.jobId), 409, "version_conflict");
      }
      const requestId = crypto.randomUUID();
      let bytes = "";
      for (const record of ["applied", "replayed"]) {
        const res = await release(id, "resume", a.jobId, requestId);
        assert.equal(res.status, 200);
        const text = await res.text();
        if (record === "applied") bytes = text;
        assert.equal(text, bytes);
        assert.deepEqual(resumeQueueResponseSchema.parse(JSON.parse(text)), { jobs: [b] });
        const trace = res.headers.get("x-trace-id");
        assert(trace);
        const line = await worker.logLine(trace);
        for (const [key, value] of Object.entries({
          requestId,
          patternId: id,
          heldBy: a.jobId,
          queue: record,
          outcome: "resumed",
        }))
          assert.equal(line[key], value);
      }
      await error(await release(id, "cancel", a.jobId, requestId), 422, "request_id_reused");
      await error(await stop(a.jobId, requestId), 422, "request_id_reused");
      await error(await release(id, "resume", a.jobId), 409, "version_conflict");
      assert.equal((await settleJobs(worker, owner, id, [b.jobId])).queueHold, null);
      const next = await accept(id);
      await settleJobs(worker, owner, id, [next.jobId]);
    },
  );
  await t.test("cancel includes instructions accepted during the hold", async () => {
    const { id, a, followers } = await waiting(2);
    followers.push(await accept(id));
    const requestId = crypto.randomUUID();
    const first = await release(id, "cancel", a.jobId, requestId);
    assert.equal(first.status, 200);
    const bytes = await first.text();
    assert.deepEqual(cancelQueueResponseSchema.parse(JSON.parse(bytes)), {
      jobs: followers.map((job) => ({ ...job, state: "cancelled" })),
    });
    const replay = await release(id, "cancel", a.jobId, requestId);
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), bytes);
    const after = await state(id);
    assert.deepEqual(after.queuedJobs, []);
    assert.equal(after.queueHold, null);
    const next = await accept(id);
    await settleJobs(worker, owner, id, [next.jobId]);
  });
  await t.test("stopping the last queued instruction releases a failed job's hold", async () => {
    const { id, followers } = await waiting(1);
    const [b] = followers;
    assert(b);
    assert.equal((await stop(b.jobId)).status, 200);
    const after = await state(id);
    assert.equal(after.queueHold, null);
    assert.deepEqual(after.queuedJobs, []);
  });
});

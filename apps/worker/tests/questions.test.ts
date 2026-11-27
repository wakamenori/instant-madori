import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  patternStateResponseSchema,
  messageListResponseSchema,
  stopJobResponseSchema,
} from "@madori/contracts";
import { newUser, startLocalWorker } from "./support/local-worker.ts";

await test(
  "question holds and answer priority through workerd HTTP",
  { timeout: 120_000 },
  async (t) => {
    const worker = await startLocalWorker({ vars: { JOB_TEST_HOLD: "first_answer:3" } });
    t.after(() => worker.stop());
    const owner = newUser("asking-owner");
    const other = newUser("asking-other");
    async function project(as = owner) {
      const response = await worker.call("/api/projects", {
        method: "POST",
        as,
        body: { requestId: crypto.randomUUID() },
      });
      assert.equal(response.status, 201);
      return createProjectResponseSchema.parse(await response.json()).pattern.id;
    }
    async function submit(
      id: string,
      body: string,
      questionId?: string,
      as = owner,
      requestId = crypto.randomUUID(),
    ) {
      return worker.call(`/api/patterns/${id}/messages`, {
        method: "POST",
        as,
        body: { requestId, body, questionId },
      });
    }
    async function accepted(response: Response) {
      assert.equal(response.status, 202);
      return acceptInstructionResponseSchema.parse(await response.json()).job;
    }
    async function state(id: string, as = owner) {
      return patternStateResponseSchema.parse(
        await (await worker.call(`/api/patterns/${id}/state`, { as })).json(),
      );
    }
    const stop = (id: string, as = owner) =>
      worker.call(`/api/jobs/${id}/stop`, {
        method: "POST",
        as,
        body: { requestId: crypto.randomUUID() },
      });
    async function rejected(response: Response, status: number, error: string) {
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    }
    const id = await project();
    const a = await accepted(await submit(id, "台本:question"));
    const b = await accepted(await submit(id, "待機指示"));
    assert.equal((await worker.logLine(a.jobId, "job.finished"))["outcome"], "asked");
    const held = await state(id);
    const first = held.queueHold?.job;
    assert(first?.state === "awaiting_answer");
    assert.equal(first.jobId, a.jobId);
    assert.equal(first.question.body, "和室は必要ですか？");
    assert.deepEqual(first.question.choices, ["必要", "不要"]);
    assert.equal(first.answer, null);
    assert.deepEqual(held.lastFinishedJob, { ...a, state: "awaiting_answer" });
    assert.equal(held.currentRevision, null);
    assert.equal(held.runningJob, null);
    assert.deepEqual(held.queuedJobs, [b]);
    const page = messageListResponseSchema.parse(
      await (await worker.call(`/api/patterns/${id}/messages`, { as: owner })).json(),
    );
    const q = page.messages.find((m) => m.kind === "question");
    assert(q);
    assert.equal(q.id, first.question.messageId);
    assert.deepEqual(q.choices, first.question.choices);
    const stopped = await stop(a.jobId);
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopJobResponseSchema.parse(await stopped.json()), {
      outcome: "already_finished",
      job: held.lastFinishedJob,
    });
    assert.deepEqual(await state(id), held);
    await rejected(await submit(id, "回答", b.messageId), 404, "not_found");
    await rejected(await submit(id, "回答", q.id, other), 404, "not_found");
    await rejected(await submit(id, "回答", crypto.randomUUID()), 404, "not_found");

    const unavailable = await worker.call(`/api/patterns/${id}/messages`, {
      as: owner,
      method: "POST",
      body: {
        requestId: crypto.randomUUID(),
        body: "必要",
        questionId: q.id,
        attachmentIds: [crypto.randomUUID()],
      },
    });
    await rejected(unavailable, 422, "attachment_unavailable");

    const requestId = crypto.randomUUID();
    const response = await submit(id, "台本:question", q.id, owner, requestId);
    const bytes = await response.clone().text();
    const answering = await accepted(response);
    const replay = await submit(id, "台本:question", q.id, owner, requestId);
    assert.equal(replay.status, 202);
    assert.equal(await replay.text(), bytes);
    await rejected(await submit(id, "再回答", q.id), 409, "version_conflict");
    assert.equal((await worker.logLine(answering.jobId, "job.finished"))["outcome"], "asked");
    const next = (await state(id)).queueHold?.job;
    assert(next?.state === "awaiting_answer");
    assert.equal(next.jobId, answering.jobId);
    const plain = await accepted(await submit(id, "必要", next.question.messageId));
    assert.equal(
      (await worker.logLine(plain.jobId, "job.finished"))["reason"],
      "containers_disabled",
    );
    const after = await state(id);
    assert.deepEqual(after.queueHold?.job, { ...next, answer: plain });
    assert.deepEqual(after.queuedJobs, [b]);
    assert(
      !worker.logEntries().some((e) => e["event"] === "job.step" && e["jobId"] === b.jobId),
      "waiting instruction never started during the hold",
    );
    assert.equal(
      (
        await worker.call(`/api/patterns/${id}/queue/resume`, {
          method: "POST",
          as: owner,
          body: { requestId: crypto.randomUUID(), heldBy: next.jobId },
        })
      ).status,
      200,
    );
    await worker.logLine(b.jobId, "job.finished");

    const otherId = await project(other);
    const asks = await accepted(await submit(otherId, "台本:question", undefined, other));
    const waits = await accepted(await submit(otherId, "待機", undefined, other));
    await worker.logLine(asks.jobId, "job.finished");
    assert.equal((await stop(waits.jobId, other)).status, 200);
    const open = (await state(otherId, other)).queueHold?.job;
    assert(
      open?.state === "awaiting_answer",
      "stopping the last waiting instruction keeps the question open",
    );
    await rejected(await submit(id, "回答", open.question.messageId), 404, "not_found");
    const last = await accepted(await submit(otherId, "不要", open.question.messageId, other));
    await worker.logLine(last.jobId, "job.finished");
    assert.equal((await state(otherId, other)).queueHold, null);
  },
);

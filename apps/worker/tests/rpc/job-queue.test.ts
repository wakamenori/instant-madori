import assert from "node:assert/strict";
import { test } from "node:test";
import { openJobDatabase, applyJobMigrations, now } from "./jobs-support.ts";
import { acceptInstruction, claimNextJob } from "../../src/services/jobs.ts";
import { requestKey } from "../../src/services/requests.ts";
import { prefix, conversationWindow } from "../../src/services/ai-context.ts";
import { emptyHouseSummary, houseSummarySchema } from "@madori/contracts/geometry-internal";
import { insertInputJobSql } from "../../src/storage/jobs.ts";
import { queueHoldSql, holdingJobIdSql } from "../../src/storage/job-queue.ts";

await test("Queue holds on real D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("stop");
  const otherId = await db.owner("other-stop");
  const deps = { store: db.store, runtime: db.runtime, wakePattern: async () => {} };
  async function pattern() {
    const result = await db.store.projects.createOnce(
      {
        ownerId,
        requestId: crypto.randomUUID(),
        operation: "project.create",
        fingerprint: "fixture",
      },
      {
        id: crypto.randomUUID(),
        name: "P",
        now,
        firstPattern: { id: crypto.randomUUID(), name: "T", defaultNamePrefix: "T" },
      },
    );
    assert(result.kind === "applied");
    return result.result.pattern.id;
  }
  async function accept(patternId: string) {
    const result = await acceptInstruction(deps, {
      ownerId,
      patternId,
      requestId: crypto.randomUUID(),
      body: "案を作って",
    });
    assert(result.kind === "accepted");
    return result.job;
  }
  const stop = async (jobId: string, requestId = crypto.randomUUID(), owner = ownerId) =>
    db.store.jobs.stopOnce(await requestKey(owner, requestId, "job.stop", { jobId }), {
      jobId,
      now,
    });
  async function setup() {
    const patternId = await pattern();
    const a = await accept(patternId);
    const b = await accept(patternId);
    const claim = await claimNextJob(deps, { patternId });
    assert(claim.kind === "claimed");
    const input = { patternId, heldBy: a.jobId, now };
    const release = async (
      action: "resume" | "cancel",
      requestId = crypto.randomUUID(),
      owner = ownerId,
      heldBy = a.jobId,
    ) => {
      const key = await requestKey(owner, requestId, `queue.${action}`, { patternId, heldBy });
      const once = action === "resume" ? db.store.queue.resumeOnce : db.store.queue.cancelOnce;
      return once(key, { ...input, heldBy });
    };
    return {
      patternId,
      a,
      b,
      right: claim.right,
      release,
      holder: () => db.store.jobs.holdingJob(patternId),
    };
  }
  await t.test(
    "answers continue the asking turn across retries, recovery and queue release",
    async () => {
      const { patternId, a, b, right, holder, release } = await setup();
      const scope = { ownerId, patternId };
      const jobs = db.store.jobs;
      const question = { id: crypto.randomUUID(), body: "色は？", choices: ["赤", "青"], now };
      await jobs.askQuestion(right, question);
      await jobs.askQuestion(right, { ...question, id: crypto.randomUUID() });
      assert.deepEqual(await jobs.restore(right.reference), { kind: "asked" });
      assert.deepEqual(await holder(), { heldBy: a.jobId });
      const answer = await acceptInstruction(deps, {
        ...scope,
        requestId: crypto.randomUUID(),
        body: "青",
        questionId: question.id,
      });
      assert(answer.kind === "accepted");
      assert.deepEqual((await db.store.revisions.state(scope))?.queuedJobs, [answer.job, b]);
      const stalled = await jobs.stalledPatterns({ unchangedSince: "2026-11-16", limit: 100 });
      assert(
        stalled.includes(patternId),
        "the held pattern with an old queued answer needs a wake",
      );
      const claim = await jobs.claim({ patternId, now });
      assert(claim.kind === "claimed");
      assert.equal(claim.right.reference.jobId, answer.job.jobId);
      const window = conversationWindow;
      const context = await jobs.startContext(claim.right, window);
      assert.deepEqual(
        context?.messages.map((m) => [m.number, m.choices]),
        [
          [a.number, null],
          [3, question.choices],
        ],
      );
      assert(context);
      const opening = await prefix("test", {
        ...context,
        summary: houseSummarySchema.parse(emptyHouseSummary),
        checks: null,
      });
      assert(
        opening.opening.some((part) => part.text.includes('色は？\nChoices: ["赤","青"]')),
        "the AI sees both the question and its choices",
      );
      const followUp = { ...question, id: crypto.randomUUID() };
      await jobs.askQuestion(claim.right, followUp);
      await jobs.askQuestion(right, question);
      assert.deepEqual(
        await holder(),
        { heldBy: answer.job.jobId },
        "stale execution cannot take back the hold",
      );
      assert.equal(
        (await db.store.revisions.state(scope))?.lastFinishedJob?.jobId,
        answer.job.jobId,
      );
      const duplicate = (id: string | null) =>
        db.raw
          .prepare(
            `INSERT INTO messages
      (id,pattern_id,owner_id,number,kind,body,created_at,question_id,answer_turn)
      VALUES(?,?,?,99,'answer','red',?,?,1)`,
          )
          .bind(crypto.randomUUID(), patternId, ownerId, now, id)
          .run();
      await assert.rejects(duplicate(null), /CHECK constraint/);
      await assert.rejects(duplicate(question.id), /UNIQUE constraint/);
      const explanationId = crypto.randomUUID();
      await db.raw
        .prepare(
          `INSERT INTO messages (id,pattern_id,owner_id,number,kind,body,created_at,job_id)
        VALUES(?,?,?,99,'explanation','summary',?,?)`,
        )
        .bind(explanationId, patternId, ownerId, now, a.jobId)
        .run();
      const ignored = await db.raw
        .prepare(insertInputJobSql)
        .bind(crypto.randomUUID(), now, now, explanationId, patternId, ownerId)
        .run();
      assert.equal(ignored.meta.changes, 0, "a job can only be created for a user input");
      await release("resume", crypto.randomUUID(), ownerId, answer.job.jobId);
      const closed = await acceptInstruction(deps, {
        ...scope,
        requestId: crypto.randomUUID(),
        body: "赤",
        questionId: followUp.id,
      });
      assert.equal(closed.kind, "version_conflict", "resume closed the unanswered question");
      const later = await jobs.claim({ patternId, now });
      assert(later.kind === "claimed");
      assert.equal(later.right.reference.jobId, b.jobId);
      const laterContext = await jobs.startContext(later.right, window);
      assert(laterContext?.messages.some((m) => m.number === answer.job.number && m.body === "青"));
      await jobs.failAndHoldQueue(later.right, now);
      assert.equal(
        (await db.store.revisions.state(scope))?.lastFinishedJob?.jobId,
        b.jobId,
        "finished jobs use turn order",
      );
    },
  );
  await t.test("stop holds once until the last waiting job is stopped", async () => {
    const { a, b, patternId, holder } = await setup();
    const c = await accept(patternId);
    await stop(b.jobId);
    assert.equal(await holder(), null);
    const id = crypto.randomUUID();
    const applied = await stop(a.jobId, id);
    assert.deepEqual(await holder(), { heldBy: a.jobId });
    assert.deepEqual(await stop(a.jobId, id), { ...applied, kind: "replayed" });
    await stop(a.jobId);
    assert.deepEqual(await holder(), { heldBy: a.jobId });
    await stop(c.jobId);
    assert.equal(await holder(), null);
    await stop(a.jobId, id);
    assert.equal(await holder(), null);
  });
  await t.test(
    "parallel claims respect a hold and a retried failure cannot restore it",
    async () => {
      const { a, b, right, patternId, release, holder } = await setup();
      const claims = () =>
        Promise.all(Array.from({ length: 20 }, () => claimNextJob(deps, { patternId })));
      await db.store.jobs.failAndHoldQueue(right, now);
      assert.deepEqual(await holder(), { heldBy: a.jobId });
      assert((await claims()).every((row) => row.kind === "not_claimed"));
      assert.deepEqual(await release("resume"), { kind: "applied", result: { jobs: [b] } });
      assert.deepEqual(await db.store.jobs.failAndHoldQueue(right, now), { kind: "not_recorded" });
      assert.equal((await claims()).filter((row) => row.kind === "claimed").length, 1);
      for (const [sql, bindings] of [
        [queueHoldSql, [patternId, ownerId]],
        [holdingJobIdSql, [patternId]],
      ] as const) {
        const plan = await db.raw
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...bindings)
          .all<{ detail: string }>();
        assert(plan.results.some((row) => row.detail.includes("jobs_one_queue_hold_per_pattern")));
      }
    },
  );
  for (const action of ["resume", "cancel"] as const) {
    await t.test(`${action} is owner scoped, bound to the holding job and replayable`, async () => {
      const { a, b, right, release } = await setup();
      await db.store.jobs.failAndHoldQueue(right, now);
      assert.equal((await release(action, crypto.randomUUID(), otherId)).kind, "not_applied");
      assert.equal(
        (await release(action, crypto.randomUUID(), ownerId, b.jobId)).kind,
        "not_applied",
      );
      const id = crypto.randomUUID();
      const applied = await release(action, id, ownerId, a.jobId);
      assert.deepEqual(applied, {
        kind: "applied",
        result: { jobs: [action === "resume" ? b : { ...b, state: "cancelled" }] },
      });
      assert.deepEqual(await release(action, id), { ...applied, kind: "replayed" });
      assert.equal(
        (await release(action === "resume" ? "cancel" : "resume", id)).kind,
        "request_id_reused",
      );
    });
  }
  await t.test("only one competing release applies", async () => {
    const { right, release } = await setup();
    await db.store.jobs.failAndHoldQueue(right, now);
    assert.deepEqual(
      (await Promise.all([release("resume"), release("cancel")])).map((row) => row.kind).sort(),
      ["applied", "not_applied"],
    );
  });
  for (const previousState of ["cancelled", "running"]) {
    await t.test(
      `acceptance repairs an empty queue left by a previous Worker (${previousState})`,
      async () => {
        const { a, b, right, patternId, holder } = await setup();
        await db.store.jobs.failAndHoldQueue(right, now);
        await db.raw
          .prepare("UPDATE jobs SET state = ?, generation = 1 WHERE id = ?")
          .bind(previousState, b.jobId)
          .run();
        assert.deepEqual(
          await acceptInstruction(deps, {
            patternId,
            ownerId,
            body: "指示",
            requestId: crypto.randomUUID(),
            attachmentIds: [crypto.randomUUID()],
          }),
          { kind: "attachment_unavailable" },
        );
        assert.deepEqual(await holder(), { heldBy: a.jobId });
        const fresh = await accept(patternId);
        assert.equal(await holder(), null);
        if (previousState === "running")
          await db.raw.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").bind(b.jobId).run();
        const claimed = await claimNextJob(deps, { patternId });
        assert(claimed.kind === "claimed");
        assert.equal(claimed.right.reference.jobId, fresh.jobId);
        assert.notEqual(fresh.jobId, a.jobId);
      },
    );
  }
});

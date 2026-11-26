import assert from "node:assert/strict";
import { test } from "node:test";
import { openJobDatabase, applyJobMigrations, now } from "./jobs-support.ts";
import { acceptInstruction, claimNextJob } from "../../src/services/jobs.ts";
import { requestKey } from "../../src/services/requests.ts";
import { queueHoldSql, queueNotHeld, holdingJobIdSql } from "../../src/storage/job-queue.ts";

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
        [`SELECT ${queueNotHeld}`, [patternId]],
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

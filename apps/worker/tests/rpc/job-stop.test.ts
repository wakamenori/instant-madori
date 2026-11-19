import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { openJobDatabase, jobMigration, now } from "./jobs-support.ts";
import {
  acceptInstruction,
  claimNextJob,
  completeJob,
  saveJobSnapshot,
} from "../../src/services/jobs.ts";
import { requestKey } from "../../src/services/requests.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";

await test("Stop orders against commit on real D1 and R2", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await db.apply(await readFile(jobMigration, "utf8"));
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
    return { jobId: result.job.id, messageId: result.message.id, number: result.message.number };
  }
  const stop = async (jobId: string, requestId = crypto.randomUUID(), owner = ownerId) =>
    db.store.jobs.stopOnce(await requestKey(owner, requestId, "job.stop", { jobId }), {
      jobId,
      now,
    });
  async function ready() {
    const patternId = await pattern();
    const job = await accept(patternId);
    const claim = await claimNextJob(deps, { patternId });
    assert(claim.kind === "claimed");
    const saved = await saveJobSnapshot(deps, {
      right: claim.right,
      display: new Uint8Array([1, 2, 3]),
    });
    assert(saved.kind === "saved");
    return { patternId, job, right: claim.right, snapshot: saved.snapshot };
  }
  const counts = () =>
    Promise.all(
      ["snapshots", "revisions"].map((table) =>
        db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"),
      ),
    );

  await t.test("queued stop skips the job and fixes its replay", async () => {
    const first = await ready();
    const queued = await accept(first.patternId);
    const requestId = crypto.randomUUID();
    const stopped = await stop(queued.jobId, requestId);
    assert.deepEqual(stopped, {
      kind: "applied",
      result: {
        patternId: first.patternId,
        outcome: "stopped",
        job: { ...queued, state: "cancelled" },
      },
    });
    assert.deepEqual(await stop(queued.jobId, requestId), { ...stopped, kind: "replayed" });
    const again = await stop(queued.jobId);
    assert(again.kind === "applied");
    assert.equal(again.result.outcome, "already_finished");
    assert.equal(
      await db.raw
        .prepare("SELECT generation FROM jobs WHERE id = ?")
        .bind(queued.jobId)
        .first("generation"),
      0,
    );
    await stop(first.job.jobId);
    assert.deepEqual(await claimNextJob(deps, { patternId: first.patternId }), {
      kind: "not_claimed",
    });
  });

  await t.test("running stop refuses save, commit and failure at its generation", async () => {
    const { right, snapshot, job } = await ready();
    const before = await counts();
    assert.equal((await stop(job.jobId)).kind, "applied");
    assert.deepEqual(await db.store.jobs.restore(right.reference), { kind: "cancelled" });
    assert.deepEqual(await db.store.jobs.restore({ ...right.reference, generation: 2 }), {
      kind: "invalid",
    });
    assert.deepEqual(await saveJobSnapshot(deps, { right, display: new Uint8Array([4]) }), {
      kind: "execution_lost",
    });
    assert.deepEqual(await completeJob(deps, { right, snapshot, name: "案" }), {
      kind: "execution_lost",
    });
    assert.deepEqual(await db.store.jobs.fail(right, now), { kind: "not_recorded" });
    assert.deepEqual(await counts(), before);
    assert.deepEqual((await db.store.snapshots.display(snapshot)).bytes, new Uint8Array([1, 2, 3]));
  });

  await t.test("a store whose R2 head runs the stop first refuses the commit batch", async () => {
    const { right, snapshot, job } = await ready();
    const before = await counts();
    const bucket = r2(db.bucket);
    const store = createStore(d1(db.raw), {
      ...bucket,
      async head(key) {
        await stop(job.jobId);
        return bucket.head(key);
      },
    });
    assert.deepEqual(await completeJob({ ...deps, store }, { right, snapshot, name: "案" }), {
      kind: "execution_lost",
    });
    assert.deepEqual(await counts(), before);
    assert.equal(
      await db.raw.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.jobId).first("state"),
      "cancelled",
    );
    assert.equal(
      await db.raw
        .prepare("SELECT count(*) AS n FROM snapshots WHERE manifest_key = ?")
        .bind(snapshot.manifestKey)
        .first("n"),
      0,
    );
  });

  await t.test("completion first records the revision and reserves the request ID", async () => {
    const { right, snapshot, job, patternId } = await ready();
    const done = await completeJob(deps, { right, snapshot, name: "案" });
    assert(done.kind === "committed");
    const before = await counts();
    const requestId = crypto.randomUUID();
    const stopped = await stop(job.jobId, requestId);
    assert.deepEqual(stopped, {
      kind: "applied",
      result: {
        patternId,
        outcome: "already_finished",
        job: { ...job, state: "completed", revision: done.revision },
      },
    });
    assert.equal(
      await db.raw
        .prepare("SELECT count(*) AS n FROM requests WHERE owner_id = ? AND request_id = ?")
        .bind(ownerId, requestId)
        .first("n"),
      1,
    );
    const other = await ready();
    assert.deepEqual(await stop(other.job.jobId, requestId), { kind: "request_id_reused" });
    assert.deepEqual(await stop(job.jobId, requestId), { ...stopped, kind: "replayed" });
    const reused = await db.store.jobs.acceptOnce(
      await requestKey(ownerId, requestId, "instruction.accept", { patternId, body: "other" }),
      { id: crypto.randomUUID(), messageId: crypto.randomUUID(), patternId, body: "other", now },
    );
    assert.equal(reused.kind, "request_id_reused");
    assert.deepEqual(await completeJob(deps, { right, snapshot, name: "案" }), done);
    assert.deepEqual(await counts(), before);
  });

  await t.test("owner isolation, missing and unused jobs leave no request record", async () => {
    const { job } = await ready();
    const requestId = crypto.randomUUID();
    assert.deepEqual(await stop(job.jobId, requestId, otherId), { kind: "not_found" });
    assert.deepEqual(await stop(crypto.randomUUID(), requestId), { kind: "not_found" });
    for (const state of ["awaiting_answer", "limited"]) {
      await db.raw.prepare("UPDATE jobs SET state = ? WHERE id = ?").bind(state, job.jobId).run();
      assert.deepEqual(await stop(job.jobId, requestId), { kind: "not_found" });
    }
    assert.equal(
      await db.raw
        .prepare("SELECT count(*) AS n FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first("n"),
      0,
    );
  });

  await t.test("every active state is stoppable and failed is already finished", async () => {
    for (const state of ["validating", "committing", "failed"]) {
      const { job } = await ready();
      await db.raw.prepare("UPDATE jobs SET state = ? WHERE id = ?").bind(state, job.jobId).run();
      const result = await stop(job.jobId);
      assert(result.kind === "applied");
      assert.equal(result.result.outcome, state === "failed" ? "already_finished" : "stopped");
      assert.equal(result.result.job.state, state === "failed" ? "failed" : "cancelled");
    }
  });
});

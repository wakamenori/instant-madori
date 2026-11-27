import { saveJobSnapshot } from "./snapshot-support.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openJobDatabase, applyJobMigrations, now } from "./jobs-support.ts";
import { stopJob, acceptInstruction, claimNextJob, completeJob } from "../../src/services/jobs.ts";
import { requestKey } from "../../src/services/requests.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";

await test("Stop orders against commit on real D1 and R2", async (t) => {
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

  await t.test(
    "a lost stop wake replays and wakes again, finished replays never wake",
    async () => {
      const { job, patternId } = await ready();
      const input = { ownerId, jobId: job.jobId, requestId: crypto.randomUUID() };
      let fail = true;
      const wakes: string[] = [];
      const service = {
        ...deps,
        wakePattern(id: string) {
          wakes.push(id);
          if (fail) return Promise.reject(new Error("wake failed"));
          return Promise.resolve();
        },
      };
      await assert.rejects(stopJob(service, input), /wake failed/);
      fail = false;
      const replay = await stopJob(service, input);
      assert(replay.kind === "stop");
      assert.equal(replay.record, "replayed");
      assert.equal(replay.result.outcome, "stopped");
      assert.deepEqual(wakes, [patternId, patternId]);
      const finished = { ...input, requestId: crypto.randomUUID() };
      const result = await stopJob(service, finished);
      assert(result.kind === "stop");
      assert.equal(result.result.outcome, "already_finished");
      assert.equal((await stopJob(service, finished)).kind, "stop");
      assert.equal(wakes.length, 2);
    },
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
    assert.deepEqual(
      await completeJob(deps, { right, snapshot, explanation: "fixture", name: "案" }),
      {
        kind: "execution_lost",
      },
    );
    assert.deepEqual(await db.store.jobs.failAndHoldQueue(right, now), { kind: "not_recorded" });
    assert.deepEqual(await counts(), before);
    assert.deepEqual(
      await (await db.store.snapshots.open(snapshot)).display.read(),
      new Uint8Array([1, 2, 3]),
    );
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
    assert.deepEqual(
      await completeJob(
        { ...deps, store },
        { right, snapshot, explanation: "fixture", name: "案" },
      ),
      {
        kind: "execution_lost",
      },
    );
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
    const done = await completeJob(deps, { right, snapshot, explanation: "fixture", name: "案" });
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
      {
        id: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        patternId,
        body: "other",
        attachmentIds: [],
        now,
      },
    );
    assert.equal(reused.kind, "request_id_reused");
    assert.deepEqual(
      await completeJob(deps, { right, snapshot, explanation: "fixture", name: "案" }),
      done,
    );
    assert.deepEqual(await counts(), before);
  });

  await t.test("parallel stop and commit choose one terminal result", async () => {
    for (let i = 0; i < 20; i++) {
      const { right, snapshot, job } = await ready();
      const before = await counts();
      const [stopped, completed] = await Promise.all([
        stop(job.jobId),
        completeJob(deps, { right, snapshot, explanation: "fixture", name: "案" }),
      ]);
      assert(stopped.kind === "applied");
      if (stopped.result.outcome === "stopped") {
        assert.deepEqual(completed, { kind: "execution_lost" });
        assert.deepEqual(await counts(), before);
      } else {
        assert(stopped.result.job.state === "completed");
        assert(completed.kind === "committed");
        assert.deepEqual(stopped.result.job.revision, completed.revision);
        assert.deepEqual(
          await counts(),
          before.map((n) => Number(n) + 1),
        );
      }
    }
  });
  await t.test("a failed stop update rolls back its request record", async () => {
    const { job } = await ready();
    const requestId = crypto.randomUUID();
    await db.raw
      .prepare(
        `CREATE TRIGGER reject_stop BEFORE UPDATE OF state ON jobs
      WHEN NEW.state = 'cancelled' BEGIN SELECT RAISE(ABORT, 'injected stop failure'); END`,
      )
      .run();
    try {
      await assert.rejects(stop(job.jobId, requestId), /injected stop failure/);
    } finally {
      await db.raw.prepare("DROP TRIGGER reject_stop").run();
    }
    assert.equal(
      await db.raw.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.jobId).first("state"),
      "running",
    );
    assert.equal(
      await db.raw
        .prepare("SELECT count(*) AS n FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first("n"),
      0,
    );
    assert.equal((await stop(job.jobId, requestId)).kind, "applied");
  });
  await t.test(
    "owner isolation, missing jobs and unwritten states leave no request record",
    async () => {
      const { job } = await ready();
      const requestId = crypto.randomUUID();
      assert.deepEqual(await stop(job.jobId, requestId, otherId), { kind: "not_found" });
      assert.deepEqual(await stop(crypto.randomUUID(), requestId), { kind: "not_found" });
      await db.raw.prepare("UPDATE jobs SET state = 'limited' WHERE id = ?").bind(job.jobId).run();
      assert.deepEqual(await stop(job.jobId, requestId), { kind: "not_found" });
      assert.equal(
        await db.raw
          .prepare("SELECT count(*) AS n FROM requests WHERE request_id = ?")
          .bind(requestId)
          .first("n"),
        0,
      );
    },
  );

  await t.test(
    "every active state is stoppable and terminal states are already finished",
    async () => {
      for (const state of ["validating", "committing", "failed", "awaiting_answer"]) {
        const { job } = await ready();
        await db.raw.prepare("UPDATE jobs SET state = ? WHERE id = ?").bind(state, job.jobId).run();
        const result = await stop(job.jobId);
        assert(result.kind === "applied");
        const finished = state === "failed" || state === "awaiting_answer";
        assert.equal(result.result.outcome, finished ? "already_finished" : "stopped");
        assert.equal(result.result.job.state, finished ? state : "cancelled");
      }
    },
  );
});

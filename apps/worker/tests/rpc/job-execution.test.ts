import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptInstruction,
  claimNextJob,
  saveJobSnapshot,
  completeJob,
  recordJobFailure,
  readActiveJob,
  readCurrentJobExecution,
} from "../../src/services/jobs.ts";
import type { JobExecutionRight as Right } from "../../src/storage/job-execution.ts";
import { readJobExecutionRight } from "../../src/storage/job-execution.ts";
import { verifyJobSnapshot } from "../../src/storage/snapshots.ts";
import type { Snapshot } from "../../src/storage/snapshots.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import type { D1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import type { R2 } from "../../src/storage/r2.ts";
import { openJobDatabase, applyJobMigrations, now } from "./jobs-support.ts";

await test("Job execution through services on real D1 and R2", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("execution");
  const otherId = await db.owner("other-execution");
  const deps = { store: db.store, runtime: db.runtime, wakePattern: async () => {} };
  async function pattern(owner = ownerId) {
    const result = await db.store.projects.createOnce(
      {
        ownerId: owner,
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
  async function accept(patternId: string, owner = ownerId) {
    const result = await acceptInstruction(deps, {
      ownerId: owner,
      patternId,
      requestId: crypto.randomUUID(),
      body: "案を作って",
    });
    assert(result.kind === "accepted");
    return result;
  }
  async function claim(patternId: string) {
    const result = await claimNextJob(deps, { patternId });
    assert(result.kind === "claimed");
    return result.right;
  }
  async function save(right: Right, display = new Uint8Array([1, 2, 3])) {
    const result = await saveJobSnapshot(deps, { right, display });
    assert(result.kind === "saved");
    return result.snapshot;
  }
  const complete = (right: Right, snapshot: Snapshot) =>
    completeJob(deps, { right, snapshot, name: "案" });
  const count = () =>
    Promise.all(
      ["snapshots", "revisions"].map((table) =>
        db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"),
      ),
    );
  const state = (right: Right) =>
    db.raw
      .prepare("SELECT state FROM jobs WHERE id = ?")
      .bind(right.reference.jobId)
      .first("state");
  async function ready(owner = ownerId) {
    const patternId = await pattern(owner);
    const accepted = await accept(patternId, owner);
    const right = await claim(patternId);
    return { patternId, accepted, right, snapshot: await save(right) };
  }

  await t.test(
    "twenty simultaneous claims per pattern pick the first instruction once",
    async () => {
      for (const patternId of [await pattern(), await pattern()]) {
        const first = await accept(patternId);
        const second = await accept(patternId);
        const results = await Promise.all(
          Array.from({ length: 20 }, () => claimNextJob(deps, { patternId })),
        );
        assert.equal(results.filter((r) => r.kind === "claimed").length, 1);
        assert.equal(results.filter((r) => r.kind === "not_claimed").length, 19);
        const winner = results.find((r) => r.kind === "claimed");
        assert(winner?.kind === "claimed");
        assert.deepEqual(winner.right.reference, {
          patternId,
          jobId: first.job.jobId,
          generation: 1,
        });
        assert.equal(readJobExecutionRight(winner.right).baseRevisionId, null);
        assert.deepEqual(await claimNextJob(deps, { patternId }), { kind: "not_claimed" });
        assert((await complete(winner.right, await save(winner.right))).kind === "committed");
        const next = await claim(patternId);
        assert.equal(next.reference.jobId, second.job.jobId);
      }
      assert.deepEqual(await claimNextJob(deps, { patternId: crypto.randomUUID() }), {
        kind: "not_claimed",
      });
    },
  );

  await t.test("concurrent completions and replays return one immutable revision", async () => {
    const { right, snapshot, patternId } = await ready();
    const otherSnapshot = await save(right, new Uint8Array([4]));
    const before = await count();
    const results = await Promise.all([
      complete(right, snapshot),
      complete(right, otherSnapshot),
      complete(right, snapshot),
    ]);
    const first = results[0];
    assert(first?.kind === "committed");
    for (const result of results) assert.deepEqual(result, first);
    assert.deepEqual(
      await count(),
      before.map((n) => Number(n) + 1),
    );
    assert.deepEqual(await saveJobSnapshot(deps, { right, display: new Uint8Array([9]) }), first);
    await accept(patternId);
    const next = await claim(patternId);
    assert.equal(readJobExecutionRight(next).baseRevisionId, first.revision.id);
    assert((await complete(next, await save(next))).kind === "committed");
    assert.deepEqual(await complete(right, otherSnapshot), first);
    assert.deepEqual(await readCurrentJobExecution(deps, right.reference), first);
    assert.equal(await state(right), "completed");
  });

  await t.test("old generations and obsolete bases cannot add snapshots or revisions", async () => {
    const old = await ready();
    await db.raw
      .prepare("UPDATE jobs SET state = 'queued' WHERE id = ?")
      .bind(old.right.reference.jobId)
      .run();
    const current = await claim(old.patternId);
    assert.equal(current.reference.generation, 2);
    const before = await count();
    assert.deepEqual(await complete(old.right, old.snapshot), { kind: "execution_lost" });
    assert.deepEqual(await recordJobFailure(deps, old.right), { kind: "not_recorded" });
    assert.deepEqual(await complete(current, old.snapshot), { kind: "invalid_snapshot" });
    assert.deepEqual(await count(), before);
    const completed = await complete(current, await save(current));
    assert(completed.kind === "committed");
    await accept(old.patternId);
    const obsolete = await claim(old.patternId);
    const obsoleteSnapshot = await save(obsolete);
    await db.raw
      .prepare(
        `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at)
      SELECT ?, pattern_id, owner_id, 2, 'Restored', snapshot_id, id, created_at FROM revisions WHERE id = ?`,
      )
      .bind(crypto.randomUUID(), completed.revision.id)
      .run();
    const afterRestore = await count();
    assert.deepEqual(await complete(obsolete, obsoleteSnapshot), { kind: "execution_lost" });
    assert.deepEqual(
      await saveJobSnapshot(deps, { right: obsolete, display: new Uint8Array([1]) }),
      { kind: "execution_lost" },
    );
    assert.deepEqual(await count(), afterRestore);
  });

  for (const failure of ["check", "revision collision", "completion update"] as const) {
    await t.test(`R2 survives ${failure} rollback and the same right retries once`, async () => {
      const { right, snapshot } = await ready();
      const before = await count();
      if (failure === "completion update") {
        await db.raw
          .prepare(
            `CREATE TRIGGER reject_completion BEFORE UPDATE OF state ON jobs
          WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END`,
          )
          .run();
      }
      try {
        if (failure === "check") {
          await assert.rejects(
            db.store.jobs.complete(right, { id: crypto.randomUUID(), name: "", snapshot, now }),
            /CHECK constraint failed/,
          );
        } else if (failure === "revision collision") {
          const existing = await ready();
          const done = await complete(existing.right, existing.snapshot);
          assert(done.kind === "committed");
          const afterExisting = await count();
          await assert.rejects(
            completeJob(
              { ...deps, runtime: { ...db.runtime, newId: () => done.revision.id } },
              { right, snapshot, name: "案" },
            ),
            /UNIQUE constraint failed/,
          );
          assert.deepEqual(await count(), afterExisting);
        } else {
          await assert.rejects(complete(right, snapshot), /injected completion failure/);
        }
      } finally {
        if (failure === "completion update")
          await db.raw.prepare("DROP TRIGGER reject_completion").run();
      }
      if (failure !== "revision collision") assert.deepEqual(await count(), before);
      assert.equal(await state(right), "running");
      assert.deepEqual(
        await (await db.store.snapshots.open(snapshot)).display.read(),
        new Uint8Array([1, 2, 3]),
      );
      const retryBefore = await count();
      const done = await complete(right, snapshot);
      assert(done.kind === "committed");
      assert.deepEqual(await complete(right, snapshot), done);
      assert.deepEqual(
        await count(),
        retryBefore.map((n) => Number(n) + 1),
      );
    });
  }

  for (const attack of [
    "foreign owner key",
    "failed job snapshot",
    "different snapshot ID",
    "foreign snapshot ID",
  ] as const) {
    await t.test(
      `snapshot attack rejects ${attack} without blocking the other owner's commit`,
      async () => {
        const own = await ready();
        const other = await ready(otherId);
        let candidate = own.snapshot;
        if (attack === "foreign owner key")
          candidate = { ...own.snapshot, manifestKey: other.snapshot.manifestKey };
        if (attack === "different snapshot ID")
          candidate = { ...own.snapshot, id: crypto.randomUUID() };
        if (attack === "foreign snapshot ID")
          candidate = {
            ...other.snapshot,
            ownerId,
            manifestKey: `owners/${ownerId}/snapshots/${other.snapshot.id}/manifest.json`,
          };
        if (attack === "failed job snapshot") {
          assert.deepEqual(await recordJobFailure(deps, own.right), { kind: "recorded" });
          await accept(own.patternId);
          const next = await claim(own.patternId);
          own.right = next;
        }
        const before = await count();
        assert.deepEqual(await complete(own.right, candidate), { kind: "invalid_snapshot" });
        assert.deepEqual(await count(), before);
        assert.equal(await state(own.right), "running");
        const done = await complete(other.right, other.snapshot);
        assert(done.kind === "committed");
        assert.deepEqual(
          await count(),
          before.map((n) => Number(n) + 1),
        );
        assert.deepEqual(
          await (await db.store.snapshots.open(other.snapshot)).display.read(),
          new Uint8Array([1, 2, 3]),
        );
      },
    );
  }

  await t.test(
    "missing manifests and wrong hashes are invalid snapshots, and head failures propagate",
    async () => {
      const { right, snapshot } = await ready();
      const before = await count();
      for (const candidate of [
        { ...snapshot, manifestSha256: "a".repeat(64) },
        { ...snapshot, ownerId: otherId },
        { ...snapshot, id: crypto.randomUUID(), manifestKey: "missing" },
        { ...snapshot, id: crypto.randomUUID() },
      ])
        assert.deepEqual(await complete(right, candidate), { kind: "invalid_snapshot" });
      const missingId = crypto.randomUUID();
      assert.deepEqual(
        await complete(right, {
          ...snapshot,
          id: missingId,
          manifestKey: `owners/${ownerId}/snapshots/${missingId}/manifest.json`,
        }),
        { kind: "invalid_snapshot" },
      );
      assert.deepEqual(await count(), before);
      assert.equal(await state(right), "running");
      const database = d1(db.raw);
      const broken = createStore(database, {
        ...r2(db.bucket),
        head: () => Promise.reject(new Error("head unavailable")),
      });
      await assert.rejects(
        completeJob({ ...deps, store: broken }, { right, snapshot, name: "案" }),
        /head unavailable/,
      );
      assert.deepEqual(await count(), before);
      assert((await complete(right, snapshot)).kind === "committed");
    },
  );

  await t.test(
    "failure and completion serialize consistently without changing queued jobs",
    async () => {
      for (const order of ["failure first", "commit first", "parallel"] as const) {
        const { right, snapshot, patternId } = await ready();
        const queued = await accept(patternId);
        const before = await count();
        if (order === "failure first") {
          assert.deepEqual(await recordJobFailure(deps, right), { kind: "recorded" });
          assert.deepEqual(await complete(right, snapshot), { kind: "execution_lost" });
        } else if (order === "commit first") {
          assert((await complete(right, snapshot)).kind === "committed");
          assert.deepEqual(await recordJobFailure(deps, right), { kind: "not_recorded" });
        } else await Promise.all([recordJobFailure(deps, right), complete(right, snapshot)]);
        const final = await state(right);
        assert(final === "failed" || final === "completed");
        assert.deepEqual(
          await count(),
          before.map((n) => Number(n) + (final === "completed" ? 1 : 0)),
        );
        assert.equal(
          await db.raw
            .prepare("SELECT state FROM jobs WHERE id = ?")
            .bind(queued.job.jobId)
            .first("state"),
          "queued",
        );
      }
    },
  );

  await t.test(
    "restore verifies state and generation and recovers a lost claim response",
    async () => {
      const patternId = await pattern();
      const accepted = await accept(patternId);
      const zero = { patternId, jobId: accepted.job.jobId, generation: 0 };
      assert.deepEqual(await readCurrentJobExecution(deps, zero), { kind: "invalid" });
      assert.equal(await readActiveJob(deps, { patternId }), null);
      await claimNextJob(deps, { patternId });
      const active = await readActiveJob(deps, { patternId });
      assert(active);
      const { reference, claimedAt } = active;
      assert.equal(claimedAt, now);
      assert.deepEqual(reference, { ...zero, generation: 1 });
      assert.deepEqual(await readCurrentJobExecution(deps, { ...reference, generation: 2 }), {
        kind: "invalid",
      });
      const restored = await readCurrentJobExecution(deps, reference);
      assert(restored.kind === "active");
      const saved = await save(restored.right);
      const before = await count();
      const done = await complete(restored.right, saved);
      assert(done.kind === "committed");
      assert.deepEqual(await readCurrentJobExecution(deps, reference), done);
      assert.deepEqual(await complete(restored.right, saved), done);
      assert.deepEqual(
        await count(),
        before.map((n) => Number(n) + 1),
      );
      assert.equal(await readActiveJob(deps, { patternId }), null);
      for (const terminal of ["failed", "cancelled"] as const) {
        const next = await ready();
        const ref = next.right.reference;
        const live = await readCurrentJobExecution(deps, ref);
        assert(live.kind === "active");
        await db.raw
          .prepare("UPDATE jobs SET state = ? WHERE id = ?")
          .bind(terminal, ref.jobId)
          .run();
        assert.deepEqual(await readCurrentJobExecution(deps, ref), {
          kind: terminal === "cancelled" ? "cancelled" : "invalid",
        });
        const before = await count();
        assert.deepEqual(await complete(live.right, next.snapshot), { kind: "execution_lost" });
        assert.deepEqual(await count(), before);
      }
    },
  );

  await t.test(
    "conversation cutoffs exclude instructions queued before, during, or between retries",
    async () => {
      for (const timing of ["before claim", "while running", "between retries"] as const) {
        const patternId = await pattern();
        const first = await accept(patternId);
        if (timing === "before claim") await accept(patternId);
        const right = await claim(patternId);
        if (timing === "while running") await accept(patternId);
        const snapshot = await save(right);
        if (timing === "between retries") {
          await assert.rejects(
            db.store.jobs.complete(right, { id: crypto.randomUUID(), name: "", snapshot, now }),
            /CHECK constraint failed/,
          );
          await accept(patternId);
        }
        const done = await complete(right, snapshot);
        assert(done.kind === "committed");
        assert.equal(
          await db.raw
            .prepare("SELECT conversation_number FROM revisions WHERE id = ?")
            .bind(done.revision.id)
            .first("conversation_number"),
          first.job.number,
        );
        const second = await claim(patternId);
        const next = await complete(second, await save(second));
        assert(next.kind === "committed");
        assert.equal(
          await db.raw
            .prepare("SELECT conversation_number FROM revisions WHERE id = ?")
            .bind(next.revision.id)
            .first("conversation_number"),
          2,
        );
      }
    },
  );

  await t.test("invalid names leave the right running without creating D1 rows", async () => {
    const { right, snapshot } = await ready();
    const before = await count();
    for (const name of ["", " ", "\u200b", "a\u0007"])
      assert.deepEqual(await completeJob(deps, { right, snapshot, name }), {
        kind: "invalid_name",
      });
    assert.deepEqual(await count(), before);
    assert.equal(await state(right), "running");
  });

  await t.test("forged rights reject before any D1 or R2 call", async () => {
    const { right, snapshot } = await ready();
    let calls = 0;
    let getters = 0;
    const realD1 = d1(db.raw);
    const observedD1: D1 = {
      async first(...args) {
        calls++;
        return realD1.first(...args);
      },
      async all(...args) {
        calls++;
        return realD1.all(...args);
      },
      async batch(...args) {
        calls++;
        return realD1.batch(...args);
      },
    };
    const realR2 = r2(db.bucket);
    const observedR2: R2 = {
      async head(...args) {
        calls++;
        return realR2.head(...args);
      },
      async read(...args) {
        calls++;
        return realR2.read(...args);
      },
      async putNew(...args) {
        calls++;
        return realR2.putNew(...args);
      },
    };
    const observed = { ...deps, store: createStore(observedD1, observedR2) };
    assert.equal((await observed.store.jobs.check(right)).kind, "active");
    assert(calls > 0);
    calls = 0;
    const fields = readJobExecutionRight(right);
    const prototype: unknown = Object.getPrototypeOf(right);
    assert(prototype !== null && typeof prototype === "object");
    const prototypeCopy: unknown = Object.create(prototype);
    const plain = { ...fields, reference: right.reference };
    const forged: unknown[] = [
      plain,
      null,
      undefined,
      42,
      structuredClone(right),
      { ...right },
      prototypeCopy,
      Object.assign(structuredClone(right), plain),
      new Proxy(right, {
        get() {
          getters++;
          return plain;
        },
      }),
      {
        get reference() {
          getters++;
          return right.reference;
        },
        ...fields,
      },
    ];
    for (const value of forged) {
      const fake = value as Right;
      const before = await count();
      for (const operation of [
        () => saveJobSnapshot(observed, { right: fake, display: new Uint8Array([1]) }),
        () => completeJob(observed, { right: fake, snapshot, name: "案" }),
        async () => recordJobFailure(observed, fake),
        () => observed.store.jobs.check(fake),
        () =>
          observed.store.jobs.complete(fake, {
            id: crypto.randomUUID(),
            snapshot,
            name: "案",
            now,
          }),
        async () => observed.store.jobs.failAndHoldQueue(fake, now),
        () => observed.store.jobs.ownedBySubject(fake, "staging:verifier"),
        () =>
          observed.store.snapshots.write(fake, {
            id: crypto.randomUUID(),
            display: new Uint8Array([1]),
            now,
          }),
        () => verifyJobSnapshot(observedR2, fake, snapshot),
      ])
        await assert.rejects(operation, TypeError);
      assert.equal(calls, 0);
      assert.deepEqual(await count(), before);
    }
    assert.equal(getters, 0);
    assert(Object.isFrozen(right));
    assert(Object.isFrozen(Object.getPrototypeOf(right)));
    type Constructor = new (token: symbol, scope: unknown) => Right;
    const constructor = right.constructor as Constructor;
    assert.throws(() => new constructor(Symbol("forged"), fields), TypeError);
    assert.deepEqual(
      await completeJob(observed, { right, snapshot, name: "案" }),
      await complete(right, snapshot),
    );
    assert(calls > 0);
  });
});

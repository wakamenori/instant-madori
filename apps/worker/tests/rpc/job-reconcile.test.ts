import { saveJobSnapshot } from "./snapshot-support.ts";
import { turnCodec } from "../../src/ai/turns.ts";
import { editingAi, appliedFixture } from "./operations-support.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptInstruction,
  claimNextJob,
  completeJob,
  keepsWatching,
  reconcilePattern,
  recovery,
  runJob,
  stopJob,
  sweepStalledPatterns,
} from "../../src/services/jobs.ts";
import type { JobExecutionReference, JobRuns } from "../../src/services/jobs.ts";
import { runAlarmCycle } from "../../src/objects/alarm-cycle.ts";
import type { Reconciliation, RunObservation } from "../../src/services/deps.ts";
import { jobInstanceId } from "../../src/workflows/job-runs.ts";
import { applyJobMigrations, openJobDatabase, now } from "./jobs-support.ts";
import { stepEngine } from "./job-steps.ts";

await test("Pattern reconciliation on D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("reconcile");
  async function fixture() {
    let minutes = 0;
    const runtime = {
      ...db.runtime,
      now: () => new Date(Date.parse(now) + minutes * 60_000).toISOString(),
    };
    const patternId = crypto.randomUUID();
    const project = await db.store.projects.createOnce(
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
        firstPattern: { id: patternId, name: "T", defaultNamePrefix: "T" },
      },
    );
    assert.equal(project.kind, "applied");
    const instances = new Map<string, RunObservation>();
    const calls: JobExecutionReference[] = [];
    const jobRuns: JobRuns = {
      observe(job) {
        calls.push(job);
        const id = jobInstanceId(job);
        const existing = instances.get(id);
        if (existing) return Promise.resolve(existing);
        instances.set(id, { kind: "progressing", instanceStatus: "running" });
        return Promise.resolve({ kind: "started" as const });
      },
    };
    const deps = {
      store: db.store,
      runtime,
      jobRuns,
      turns: turnCodec,
      ai: {
        forNewJob: () => Promise.resolve(editingAi),
        continuing: (model: string) => {
          assert.equal(model, editingAi.model);
          return editingAi;
        },
      },
      testHold: null,
      wakePattern: async () => {},
      geometry: () => ({
        summarizeHouse() {
          throw new Error("Unexpected summarizeHouse");
        },
        applyOperations: () => Promise.resolve(appliedFixture),
      }),
    };
    async function accept() {
      const a = await acceptInstruction(deps, {
        patternId,
        ownerId,
        body: "作って",
        requestId: crypto.randomUUID(),
      });
      assert(a.kind === "accepted");
      return a.job.jobId;
    }
    async function claim() {
      const c = await claimNextJob(deps, { patternId });
      assert(c.kind === "claimed");
      return c.right;
    }
    async function snapshot() {
      const { results: jobs } = await db.raw
        .prepare(
          "SELECT id,state,generation,base_revision_id,holds_queue,updated_at FROM jobs WHERE pattern_id=? ORDER BY id",
        )
        .bind(patternId)
        .all();
      const revisions = await db.raw
        .prepare("SELECT count(*) AS n FROM revisions WHERE pattern_id=?")
        .bind(patternId)
        .first<number>("n");
      return { jobs, revisions, instances: [...instances.keys()] };
    }
    const reconcile = () => reconcilePattern(deps, { patternId });
    async function twice() {
      const first = await reconcile();
      const after = await snapshot();
      const second = await reconcile();
      assert.deepEqual(await snapshot(), after);
      return { first, second };
    }
    const run = (job: JobExecutionReference) => runJob(deps, job, stepEngine().steps);
    return {
      accept,
      claim,
      run,
      calls,
      deps,
      patternId,
      instances,
      snapshot,
      twice,
      reconcile,
      age: (value: number) => {
        minutes = value;
      },
    };
  }
  await t.test("sweep wakes an unclaimed job after five minutes", async () => {
    const f = await fixture();
    const jobId = await f.accept();
    const woken: string[] = [];
    const sweep = () =>
      sweepStalledPatterns({
        ...f.deps,
        wakePattern: (id) => {
          woken.push(id);
          return Promise.resolve();
        },
      });
    f.age(4);
    assert.equal((await sweep()).found, 0);
    f.age(6);
    assert.deepEqual(await sweep(), { found: 1, woken: 1, wakeFailed: 0, truncated: false });
    assert.deepEqual(woken, [f.patternId]);
    const { first, second } = await f.twice();
    assert.deepEqual(first, {
      kind: "claimed",
      job: { jobId, patternId: f.patternId, generation: 1 },
    });
    assert.equal(second.kind, "running");
    assert.deepEqual([...f.instances.keys()], [`job-${jobId}-g1`]);
    assert.equal((await sweep()).found, 0);
  });
  for (const status of ["errored", "terminated", "complete", "paused"]) {
    await t.test(`lost instance ${status} fails once and holds the queue`, async () => {
      const f = await fixture();
      const a = await f.accept();
      const right = await f.claim();
      const b = await f.accept();
      const saved = await saveJobSnapshot(f.deps, { right, display: new Uint8Array([1]) });
      assert(saved.kind === "saved");
      f.instances.set(jobInstanceId(right.reference), {
        kind: status === "paused" ? "stalled" : "ended",
        instanceStatus: status,
      });
      f.age(status === "paused" ? 24 * 60 : 10);
      const { first, second } = await f.twice();
      assert.equal(first.kind, "failed_lost_run");
      assert.deepEqual(second, { kind: "queue_held", heldBy: a });
      const after = await f.snapshot();
      assert.deepEqual(
        after.jobs
          .map((row) => [row["id"], row["state"], row["generation"], row["holds_queue"]])
          .sort(),
        [
          [a, "failed", 1, 1],
          [b, "queued", 0, 0],
        ].sort(),
      );
      assert.deepEqual(
        await completeJob(f.deps, {
          right,
          explanation: "fixture",
          name: "old",
          snapshot: saved.snapshot,
        }),
        { kind: "execution_lost" },
      );
      assert.equal((await f.run(right.reference)).kind, "not_running");
      assert.deepEqual(await f.snapshot(), after);
      const found = await db.store.jobs.stalledPatterns({
        unchangedSince: f.deps.runtime.now(),
        limit: 200,
      });
      assert(!found.includes(f.patternId));
      assert.equal(f.calls.length, 1);
    });
  }
  for (const status of ["queued", "running", "waiting", "rollingBack", "paused"]) {
    await t.test(`observe ${status} without a write`, async () => {
      const f = await fixture();
      await f.accept();
      const { reference } = await f.claim();
      const stalled = status === "paused";
      f.instances.set(jobInstanceId(reference), {
        kind: stalled ? "stalled" : "progressing",
        instanceStatus: status,
      });
      for (const age of [0, 23 * 60]) {
        f.age(age);
        const before = await f.snapshot();
        const { first } = await f.twice();
        assert.deepEqual(first, {
          kind: stalled ? "stalled" : "running",
          job: reference,
          instanceStatus: status,
        });
        assert.deepEqual(await f.snapshot(), before);
      }
    });
  }
  await t.test("a lost claim response recreates the same generation and commits once", async () => {
    const f = await fixture();
    await f.accept();
    await assert.rejects(
      reconcilePattern(
        {
          ...f.deps,
          store: {
            jobs: {
              ...db.store.jobs,
              async claim(input) {
                await db.store.jobs.claim(input);
                throw new Error("claim response lost");
              },
            },
          },
        },
        { patternId: f.patternId },
      ),
      /claim response lost/,
    );
    const before = await f.snapshot();
    const { first } = await f.twice();
    assert(first.kind === "run_restarted");
    assert.equal(first.job.generation, 1);
    assert.deepEqual((await f.snapshot()).jobs, before.jobs);
    assert.equal((await f.run(first.job)).kind, "committed");
    assert.equal((await f.snapshot()).revisions, 1);
    const next = await f.accept();
    await stopJob(f.deps, { ownerId, requestId: crypto.randomUUID(), jobId: next });
    const final = await f.snapshot();
    const calls = f.calls.length;
    assert.equal((await f.twice()).first.kind, "idle");
    assert.equal(f.calls.length, calls);
    assert.deepEqual(await f.snapshot(), final);
    f.age(10);
    assert(
      !(
        await db.store.jobs.stalledPatterns({ unchangedSince: f.deps.runtime.now(), limit: 200 })
      ).includes(f.patternId),
    );
  });
  await t.test("concurrent reconciliations claim jobs in order", async () => {
    const f = await fixture();
    const a = await f.accept();
    const b = await f.accept();
    const results = await Promise.all([f.reconcile(), f.reconcile()]);
    assert.deepEqual(results.map((r) => r.kind).sort(), ["claimed", "running"]);
    assert.deepEqual(
      f.calls.map((j) => j.jobId),
      [a, a],
    );
    const first = f.calls[0];
    assert(first);
    await f.run(first);
    const { first: next } = await f.twice();
    assert(next.kind === "claimed");
    assert.equal(next.job.jobId, b);
  });
  await t.test("failure and queue hold roll back together", async () => {
    const f = await fixture();
    const a = await f.accept();
    const right = await f.claim();
    await f.accept();
    f.instances.set(jobInstanceId(right.reference), { kind: "ended", instanceStatus: "errored" });
    const before = await f.snapshot();
    await db.raw
      .prepare(
        "CREATE TRIGGER inject_hold_failure AFTER UPDATE OF state ON jobs WHEN NEW.state = 'failed' AND NEW.holds_queue = 1 BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    await assert.rejects(f.reconcile(), /injected/);
    assert.deepEqual(await f.snapshot(), before);
    await db.raw.prepare("DROP TRIGGER inject_hold_failure").run();
    const { first, second } = await f.twice();
    assert.equal(first.kind, "failed_lost_run");
    assert.deepEqual(second, { kind: "queue_held", heldBy: a });
  });

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function activeJob(f: Fixture, observation?: RunObservation) {
    await f.accept();
    const { reference } = await f.claim();
    if (observation) f.instances.set(jobInstanceId(reference), observation);
  }
  async function lostRun(f: Fixture) {
    await activeJob(f, { kind: "ended", instanceStatus: "errored" });
    f.age(10);
  }
  const watching = {
    claimed: {
      watches: true,
      async arrange(f) {
        await f.accept();
      },
    },
    run_restarted: { watches: true, arrange: activeJob },
    running: {
      watches: true,
      arrange: (f) => activeJob(f, { kind: "progressing", instanceStatus: "running" }),
    },
    stalled: {
      watches: true,
      arrange: (f) => activeJob(f, { kind: "stalled", instanceStatus: "paused" }),
    },
    failed_lost_run: { watches: true, arrange: lostRun },
    settled_meanwhile: {
      watches: true,
      async arrange(f) {
        await activeJob(f);
        f.deps.jobRuns.observe = async (job) => {
          assert.equal((await f.run(job)).kind, "committed");
          return { kind: "ended", instanceStatus: "complete" };
        };
      },
    },
    queue_held: {
      watches: false,
      async arrange(f) {
        await lostRun(f);
        await f.accept();
        assert.equal((await f.reconcile()).kind, "failed_lost_run");
      },
    },
    idle: { watches: false, arrange: () => Promise.resolve() },
  } satisfies Record<
    Reconciliation["kind"],
    { watches: boolean; arrange: (f: Fixture) => Promise<void> }
  >;

  for (const [kind, scenario] of Object.entries(watching)) {
    await t.test(`alarm after reconciliation: ${kind}`, async () => {
      const f = await fixture();
      await scenario.arrange(f);
      const alarmTime = Date.parse(now);
      let alarm: number | null = null;
      await runAlarmCycle({
        storage: {
          setAlarm(time) {
            alarm = Number(time);
            return Promise.resolve();
          },
          getAlarm: () => Promise.resolve(alarm),
          deleteAlarm() {
            alarm = null;
            return Promise.resolve();
          },
        },
        now: () => alarmTime,
        reconcile: async () => {
          const outcome = await f.reconcile();
          assert.equal(outcome.kind, kind);
          return keepsWatching(outcome);
        },
        failed(error) {
          throw error;
        },
      });
      assert.equal(alarm, scenario.watches ? alarmTime + 30_000 : null);
    });
  }
});

void test("a full sweep wakes the other patterns when one wake fails", async () => {
  const patterns = Array.from({ length: 200 }, () => crypto.randomUUID());
  const calls: string[] = [];
  const result = await sweepStalledPatterns({
    runtime: {
      now: () => now,
      newId: () => crypto.randomUUID(),
      newTraceId: () => crypto.randomUUID(),
    },
    store: {
      jobs: {
        stalledPatterns: ({ limit, unchangedSince }) => {
          assert.equal(limit, patterns.length);
          assert.equal(Date.parse(unchangedSince), Date.parse(now) - recovery.sweepUnchangedMs);
          return Promise.resolve(patterns);
        },
      },
    },
    wakePattern: (id) => {
      calls.push(id);
      return id === patterns[0] ? Promise.reject(new Error("unavailable")) : Promise.resolve();
    },
  });
  assert.deepEqual(calls, patterns);
  assert.deepEqual(result, { found: 200, woken: 199, wakeFailed: 1, truncated: true });
});

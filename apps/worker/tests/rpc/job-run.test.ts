import { scriptedAi } from "../../src/ai/scripted.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptInstruction,
  claimNextJob,
  runJob,
  sampleRevisionName,
  jobReferenceSchema,
} from "../../src/services/jobs.ts";
import type { JobExecutionReference } from "../../src/services/jobs.ts";
import type { JobWorkflowDeps } from "../../src/services/deps.ts";
import type { GeometryResult, DisplayArtifact } from "../../src/geometry/geometry-protocol.ts";
import { requestKey } from "../../src/services/requests.ts";
import { jobTestHoldSettingSchema } from "../../src/services/job-test-hold.ts";
import { jobInstanceId, jobRuns } from "../../src/workflows/job-runs.ts";
import { applyJobMigrations, openJobDatabase, now } from "./jobs-support.ts";

import { stepEngine } from "./job-steps.ts";
await test("Job runs restore D1 execution rights across retries and lost responses", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("job-run");
  const base = {
    ai: scriptedAi([]),
    testHold: null,
    store: db.store,
    runtime: db.runtime,
    wakePattern: async () => {},
  };
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
  const request = (patternId: string) => ({
    ownerId,
    patternId,
    requestId: crypto.randomUUID(),
    body: "作って",
  });
  async function accept(patternId: string) {
    const result = await acceptInstruction(base, request(patternId));
    assert(result.kind === "accepted");
    return result.job;
  }
  const ok: GeometryResult<DisplayArtifact> = {
    kind: "ok",
    value: { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "application/octet-stream" },
    start: "warm",
    ms: 1,
  };
  async function fixture(results: GeometryResult<DisplayArtifact>[] = [ok]) {
    const patternId = await pattern();
    const accepted = await accept(patternId);
    const claimed = await claimNextJob(base, { patternId });
    assert(claimed.kind === "claimed");
    const job = claimed.right.reference;
    const wakes: string[] = [];
    const calls: string[] = [];
    const deps: JobWorkflowDeps = {
      ...base,
      wakePattern: (id) => {
        wakes.push(id);
        return Promise.resolve();
      },
      geometry: (key) => {
        assert.deepEqual(key, { kind: "pattern", patternId });
        return {
          sampleDisplay(call) {
            assert.equal(call.traceId, accepted.jobId);
            calls.push(call.traceId);
            const result = results[Math.min(calls.length - 1, results.length - 1)];
            assert(result);
            return Promise.resolve(result);
          },
        };
      },
    };
    const state = () =>
      db.raw.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.jobId).first<string>("state");
    const revisions = () => db.store.revisions.list({ ownerId, patternId, after: null, limit: 50 });
    const snapshots = () =>
      db.raw
        .prepare(
          "SELECT count(*) AS n FROM snapshots WHERE id IN (SELECT snapshot_id FROM revisions WHERE pattern_id = ?)",
        )
        .bind(patternId)
        .first<number>("n");
    return { job, deps, calls, wakes, state, revisions, snapshots };
  }
  async function stop(jobId: string) {
    return db.store.jobs.stopOnce(
      await requestKey(ownerId, crypto.randomUUID(), "job.stop", { jobId }),
      { jobId, now },
    );
  }
  for (const at of ["before_render", "before_commit"] as const) {
    await t.test(`stop during ${at} ends cancelled and wakes without a revision`, async () => {
      const f = await fixture();
      const engine = stepEngine();
      const before = new Set((await db.bucket.list()).objects.map((object) => object.key));
      const end = await runJob(
        { ...f.deps, testHold: { at, seconds: 3, scope: "every_job" } },
        f.job,
        {
          ...engine.steps,
          async sleep(name, ms) {
            assert.equal(
              name,
              at === "before_render" ? "test hold before render" : "test hold before commit",
            );
            assert.equal(ms, 3000);
            await stop(f.job.jobId);
          },
        },
      );
      assert.deepEqual(end, { kind: "cancelled" });
      assert.equal(await f.state(), "cancelled");
      assert.deepEqual((await f.revisions())?.revisions, []);
      assert.deepEqual(f.wakes, [f.job.patternId]);
      assert(!engine.attempts.includes("record failure"));
      assert.equal(f.calls.length, at === "before_render" ? 0 : 1);
      assert.equal(
        (await db.bucket.list()).objects.filter((o) => !before.has(o.key)).length,
        at === "before_render" ? 0 : 2,
      );
    });
  }
  await t.test("a stop during geometry discards the arriving result", async () => {
    const f = await fixture();
    const end = await runJob(
      {
        ...f.deps,
        geometry: () => ({
          async sampleDisplay() {
            await stop(f.job.jobId);
            return ok;
          },
        }),
      },
      f.job,
      stepEngine().steps,
    );
    assert.deepEqual(end, { kind: "cancelled" });
    assert.equal(await f.snapshots(), 0);
    assert.deepEqual((await f.revisions())?.revisions, []);
  });
  await t.test("a stop inside completion still ends cancelled", async () => {
    const f = await fixture();
    const end = await runJob(
      {
        ...f.deps,
        store: {
          ...f.deps.store,
          jobs: {
            ...db.store.jobs,
            async complete(right, input) {
              await stop(f.job.jobId);
              return db.store.jobs.complete(right, input);
            },
          },
        },
      },
      f.job,
      stepEngine().steps,
    );
    assert.deepEqual(end, { kind: "cancelled" });
    assert.equal(await f.snapshots(), 0);
    assert.deepEqual((await f.revisions())?.revisions, []);
  });
  await t.test("a stop between the failure read and update still ends cancelled", async () => {
    const f = await fixture([{ kind: "unavailable", reason: "containers_disabled" }]);
    const end = await runJob(
      {
        ...f.deps,
        store: {
          ...f.deps.store,
          jobs: {
            ...db.store.jobs,
            async failAndHoldQueue(right, time) {
              await stop(f.job.jobId);
              return db.store.jobs.failAndHoldQueue(right, time);
            },
          },
        },
      },
      f.job,
      stepEngine().steps,
    );
    assert.deepEqual(end, { kind: "cancelled" });
    assert.equal(await f.state(), "cancelled");
    assert.deepEqual(f.wakes, [f.job.patternId]);
  });
  await t.test("staging holds the verifier only and stopped jobs skip the hold", async () => {
    const f = await fixture();
    const hold = jobTestHoldSettingSchema.parse({
      ENVIRONMENT: "staging",
      JOB_TEST_HOLD: "before_render:2",
    });
    let sleeps = 0;
    const steps = () => ({
      ...stepEngine().steps,
      sleep() {
        sleeps++;
        return Promise.resolve();
      },
    });
    assert.equal(
      await db.store.jobs.ownedBySubject(await claimFor(f.job), "staging:verifier"),
      false,
    );
    await runJob({ ...f.deps, testHold: hold }, f.job, steps());
    assert.equal(sleeps, 0);
    const verifier = await fixture();
    await db.raw
      .prepare("UPDATE users SET access_subject = ? WHERE id = ?")
      .bind("staging:verifier", ownerId)
      .run();
    await runJob({ ...verifier.deps, testHold: hold }, verifier.job, steps());
    assert.equal(sleeps, 1);
    const stopped = await fixture();
    await stop(stopped.job.jobId);
    assert.deepEqual(await runJob({ ...stopped.deps, testHold: hold }, stopped.job, steps()), {
      kind: "cancelled",
    });
    assert.equal(sleeps, 1);
  });
  async function claimFor(job: JobExecutionReference) {
    const restored = await db.store.jobs.restore(job);
    assert(restored.kind === "active");
    return restored.right;
  }
  await t.test("commits one sample revision and wakes once", async () => {
    const f = await fixture();
    const engine = stepEngine();
    const end = await runJob(f.deps, f.job, engine.steps);
    assert(end.kind === "committed");
    const page = await f.revisions();
    assert.equal(page?.revisions.length, 1);
    assert.equal(page.revisions[0]?.id, end.revisionId);
    assert.equal(page.revisions[0]?.name, sampleRevisionName);
    assert.equal(page.revisions[0]?.baseRevisionId, null);
    assert.deepEqual(f.wakes, [f.job.patternId]);
    assert.deepEqual(engine.attempts, ["render snapshot", "commit revision", "wake pattern"]);
    assert.deepEqual(await runJob(f.deps, f.job, engine.steps), end);
    assert.deepEqual(f.wakes, [f.job.patternId], "cached steps never repeat side effects");
    const repeated = await runJob(f.deps, f.job, stepEngine().steps);
    assert.deepEqual(repeated, end);
    assert.equal(f.calls.length, 1, "a committed job skips the Container");
  });
  for (const reason of [
    "containers_disabled",
    "protocol_mismatch",
    "build_failed",
    "protocol_violation",
  ] as const) {
    await t.test(`${reason} fails permanently on the first render attempt`, async () => {
      const result: GeometryResult<DisplayArtifact> =
        reason === "containers_disabled" || reason === "protocol_mismatch"
          ? { kind: "unavailable", reason }
          : reason === "protocol_violation"
            ? { kind: "failed", reason, status: 200, violation: "content_type" }
            : { kind: "failed", reason, status: 500 };
      const f = await fixture([result]);
      const end = await runJob(f.deps, f.job, stepEngine().steps);
      assert.deepEqual(end, { kind: "failed", reason });
      assert.equal(f.calls.length, 1);
      assert.equal(await f.state(), "failed");
      assert.equal(await f.snapshots(), 0);
      assert.deepEqual((await f.revisions())?.revisions, []);
    });
  }
  await t.test("unreachable exhausts four render attempts then records failure", async () => {
    const f = await fixture([{ kind: "unavailable", reason: "unreachable" }]);
    assert.deepEqual(await runJob(f.deps, f.job, stepEngine().steps), {
      kind: "failed",
      reason: "retries_exhausted",
    });
    assert.equal(f.calls.length, 4);
    assert.equal(await f.state(), "failed");
  });
  await t.test("unreachable followed by success commits", async () => {
    const f = await fixture([{ kind: "unavailable", reason: "unreachable" }, ok]);
    assert.equal((await runJob(f.deps, f.job, stepEngine().steps)).kind, "committed");
    assert.equal(f.calls.length, 2);
  });
  await t.test(
    "a replayed render leaves two manifests but commits only its persisted snapshot",
    async () => {
      const f = await fixture();
      const before = new Set((await db.bucket.list()).objects.map((object) => object.key));
      const engine = stepEngine({ rerun: "render snapshot" });
      assert.equal((await runJob(f.deps, f.job, engine.steps)).kind, "committed");
      assert.equal(f.calls.length, 2);
      const manifests = (await db.bucket.list()).objects.filter(
        (object) => !before.has(object.key) && object.key.endsWith("manifest.json"),
      );
      assert.equal(manifests.length, 2);
      assert.equal(await f.snapshots(), 1);
      const saved = engine.cache.get("render snapshot");
      assert(saved && typeof saved === "object" && "snapshot" in saved);
      const revision = (await f.revisions())?.revisions[0];
      assert(revision);
      assert.deepEqual(
        await db.store.revisions.snapshot({ ownerId, revisionId: revision.id }),
        saved.snapshot,
      );
    },
  );
  for (const mode of ["rerun", "loseResults"] as const) {
    await t.test(`${mode} commit responses keep exactly one revision`, async () => {
      const f = await fixture();
      const engine = stepEngine({ [mode]: "commit revision" });
      assert.equal((await runJob(f.deps, f.job, engine.steps)).kind, "committed");
      assert.equal((await f.revisions())?.revisions.length, 1);
      assert.equal(await f.state(), "completed");
      assert.equal(
        engine.attempts.filter((name) => name === "commit revision").length,
        mode === "loseResults" ? 6 : 1,
      );
    });
  }
  await t.test("replaying the failure record returns not_running", async () => {
    const f = await fixture([{ kind: "unavailable", reason: "containers_disabled" }]);
    assert.deepEqual(await runJob(f.deps, f.job, stepEngine({ rerun: "record failure" }).steps), {
      kind: "not_running",
      reason: "containers_disabled",
    });
    assert.equal(await f.state(), "failed");
  });
  await t.test("a stale generation writes nothing and still wakes", async () => {
    const f = await fixture();
    assert.deepEqual(await runJob(f.deps, { ...f.job, generation: 2 }, stepEngine().steps), {
      kind: "not_running",
      reason: "execution_lost",
    });
    assert.deepEqual(f.calls, []);
    assert.equal(await f.state(), "running");
    assert.equal(await f.snapshots(), 0);
    assert.deepEqual(f.wakes, [f.job.patternId]);
  });
  await t.test(
    "acceptance wakes applied and replayed receipts and retries a lost wake",
    async () => {
      const patternId = await pattern();
      const input = request(patternId);
      const wakes: string[] = [];
      let fail = true;
      const deps = {
        ...base,
        wakePattern(id: string) {
          wakes.push(id);
          if (fail) return Promise.reject(new Error("wake failed"));
          return Promise.resolve();
        },
      };
      await assert.rejects(acceptInstruction(deps, input), /wake failed/);
      fail = false;
      const replay = await acceptInstruction(deps, input);
      assert(replay.kind === "accepted");
      assert.equal(replay.acceptance, "replayed");
      assert.deepEqual(wakes, [patternId, patternId]);
      assert.equal((await acceptInstruction(deps, request(patternId))).kind, "accepted");
      assert.equal(wakes.length, 3);
      for (const changed of [
        { ...input, body: "changed" },
        { ...request(patternId), body: "" },
        request(crypto.randomUUID()),
      ])
        await acceptInstruction(deps, changed);
      assert.equal(wakes.length, 3);
    },
  );
});

void test("Workflow run IDs and createBatch classify duplicates without platform imports", async () => {
  const job = { patternId: crypto.randomUUID(), jobId: crypto.randomUUID(), generation: 1 };
  const id = jobInstanceId(job);
  assert.equal(id, `job-${job.jobId}-g1`);
  assert.match(id, /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
  assert(id.length <= 100);
  for (const [code, status, kind] of [
    [0, "unused", "started"],
    [10415, "unused", "reject"],
    ...["queued", "running", "waiting", "rollingBack"].map(
      (status) => [10405, status, "progressing"] as const,
    ),
    ...["paused", "waitingForPause", "unknown", "future", "unreadable"].map(
      (status) => [10405, status, "stalled"] as const,
    ),
    ...["terminated", "complete", "errored"].map((status) => [10405, status, "ended"] as const),
  ] as const) {
    const instance: WorkflowInstance = {
      id,
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {},
      restart: async () => {},
      delete: async () => {},
      sendEvent: async () => {},
      status: () => {
        if (status === "unreadable") return Promise.reject(new Error("unavailable"));
        return Promise.resolve({ status: status as InstanceStatus["status"] });
      },
      subscribe: () => Promise.reject(new Error("unused")),
    };
    function createBatch(
      input: WorkflowBatchCreateOptions<JobExecutionReference>,
    ): Promise<WorkflowBatchCreateResult>;
    function createBatch(
      input: WorkflowInstanceCreateOptions<JobExecutionReference>[],
    ): Promise<WorkflowInstance[]>;
    function createBatch(
      input:
        | WorkflowBatchCreateOptions<JobExecutionReference>
        | WorkflowInstanceCreateOptions<JobExecutionReference>[],
    ): Promise<WorkflowBatchCreateResult | WorkflowInstance[]> {
      assert.deepEqual(input, { instances: [{ id, params: job }] });
      return Promise.resolve({
        created: code === 0 ? [instance] : [],
        errors: code === 0 ? [] : [{ index: 0, id, code, message: "fixture" }],
      });
    }
    const runs = jobRuns({
      createBatch,
      get: (requested) => {
        assert.equal(requested, id);
        assert.equal(code, 10405);
        return Promise.resolve(instance);
      },
    });
    if (code === 10415) await assert.rejects(runs.observe(job), /10415/);
    else
      assert.deepEqual(
        await runs.observe(job),
        code === 0 ? { kind } : { kind, instanceStatus: status },
      );
  }
  assert.throws(() => jobReferenceSchema.parse({ ...job, generation: 0 }));
  assert.throws(() => jobReferenceSchema.parse({ ...job, extra: true }));
});

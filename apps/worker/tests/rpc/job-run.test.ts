import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptInstruction,
  advancePattern,
  claimNextJob,
  runJob,
  sampleRevisionName,
  jobReferenceSchema,
} from "../../src/services/jobs.ts";
import type { JobExecutionReference, JobSteps, JobStepConfig } from "../../src/services/jobs.ts";
import type { JobWorkflowDeps } from "../../src/services/deps.ts";
import type { GeometryResult, DisplayArtifact } from "../../src/geometry/geometry-protocol.ts";
import { requestKey } from "../../src/services/requests.ts";
import { jobTestHoldSettingSchema } from "../../src/services/job-test-hold.ts";
import { jobInstanceId, jobRuns } from "../../src/workflows/job-runs.ts";
import { applyJobMigrations, openJobDatabase, now } from "./jobs-support.ts";

function plain(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const prototype: unknown = Object.getPrototypeOf(value);
  assert(
    prototype === Object.prototype || prototype === Array.prototype,
    "step results are plain serializable data",
  );
  for (const child of Object.values(value)) plain(child);
}
function stepEngine({ rerun, loseResults }: { rerun?: string; loseResults?: string } = {}) {
  const cache = new Map<string, unknown>();
  const attempts: string[] = [];
  const steps: JobSteps = {
    sleep: async () => {},
    async do<T extends Rpc.Serializable<T> & { kind: string }>(
      name: string,
      config: JobStepConfig,
      body: () => Promise<T>,
    ) {
      if (cache.has(name)) return structuredClone(cache.get(name)) as T;
      for (let attempt = 0; ; attempt++) {
        attempts.push(name);
        try {
          if (name === rerun) {
            plain(await body());
          }
          const result = await body();
          plain(result);
          if (name === loseResults) throw new Error("Step result lost");
          cache.set(name, result);
          return structuredClone(result);
        } catch (error) {
          if (attempt === config.retries.limit) throw error;
        }
      }
    },
  };
  return { steps, cache, attempts };
}

await test("Job runs restore D1 execution rights across retries and lost responses", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("job-run");
  const base = {
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
            assert.equal(call.traceId, accepted.id);
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
  await t.test("concurrent advances claim in order and reconcile the same generation", async () => {
    const patternId = await pattern();
    const a = await accept(patternId);
    const b = await accept(patternId);
    const starts: JobExecutionReference[] = [];
    const deps = {
      ...base,
      jobRuns: {
        start(job: JobExecutionReference) {
          starts.push(job);
          return Promise.resolve("created" as const);
        },
      },
    };
    const results = await Promise.all([
      advancePattern(deps, { patternId }),
      advancePattern(deps, { patternId }),
    ]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ["claimed", "running"]);
    assert.deepEqual(starts, [
      { patternId, jobId: a.id, generation: 1 },
      { patternId, jobId: a.id, generation: 1 },
    ]);
    assert.equal(
      await db.raw
        .prepare("SELECT count(*) AS n FROM jobs WHERE pattern_id = ? AND state = 'running'")
        .bind(patternId)
        .first("n"),
      1,
    );
    assert.equal(
      (
        await runJob(
          { ...base, geometry: () => ({ sampleDisplay: () => Promise.resolve(ok) }) },
          jobReferenceSchema.parse(starts[0]),
          stepEngine().steps,
        )
      ).kind,
      "committed",
    );
    const next = await advancePattern(deps, { patternId });
    assert(next.kind === "claimed");
    assert.equal(next.job.jobId, b.id);
    const empty = await pattern();
    assert.deepEqual(await advancePattern(deps, { patternId: empty }), { kind: "idle" });
  });
  await t.test("a lost claim response reconciles generation one", async () => {
    const patternId = await pattern();
    const a = await accept(patternId);
    let lose = true;
    const deps = {
      ...base,
      store: {
        jobs: {
          ...db.store.jobs,
          async claim(input: Parameters<typeof db.store.jobs.claim>[0]) {
            const result = await db.store.jobs.claim(input);
            if (lose) {
              lose = false;
              throw new Error("claim response lost");
            }
            return Promise.resolve(result);
          },
        },
      },
      jobRuns: {
        start() {
          return Promise.resolve("created" as const);
        },
      },
    };
    await assert.rejects(advancePattern(deps, { patternId }), /claim response lost/);
    assert.deepEqual(await advancePattern(deps, { patternId }), {
      kind: "running",
      job: { patternId, jobId: a.id, generation: 1 },
      instance: "created",
    });
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
  for (const code of [0, 10405, 10415]) {
    const instance: WorkflowInstance = {
      id,
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {},
      restart: async () => {},
      delete: async () => {},
      sendEvent: async () => {},
      status: () => Promise.resolve({ status: "queued" }),
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
    const runs = jobRuns({ createBatch });
    if (code === 10415) await assert.rejects(runs.start(job), /10415/);
    else assert.equal(await runs.start(job), code === 0 ? "created" : "existing");
  }
  assert.throws(() => jobReferenceSchema.parse({ ...job, generation: 0 }));
  assert.throws(() => jobReferenceSchema.parse({ ...job, extra: true }));
});

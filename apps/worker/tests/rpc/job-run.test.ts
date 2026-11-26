import { legacySnapshot } from "./snapshot-support.ts";
import { completeJob } from "../../src/services/jobs.ts";
import { scriptedAi } from "../../src/ai/scripted.ts";
import type { Ai, AiRequest } from "../../src/ai/round-trip.ts";
import { aiToolSchemaVersion } from "@madori/contracts/ai-tools";

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptInstruction,
  claimNextJob,
  runJob,
  jobReferenceSchema,
} from "../../src/services/jobs.ts";
import type { JobExecutionReference } from "../../src/services/jobs.ts";
import type { JobWorkflowDeps } from "../../src/services/deps.ts";

import { turnCodec } from "../../src/ai/turns.ts";

import { editingAi, appliedFixture, type OperationsResult } from "./operations-support.ts";
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
    turns: turnCodec,
    ai: editingAi,
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
  const ok = appliedFixture;
  async function fixture(results: OperationsResult[] = [ok], existingPattern?: string) {
    const patternId = existingPattern ?? (await pattern());
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
          sampleDisplay() {
            throw new Error("Unexpected sampleDisplay");
          },
          applyOperations(call, request) {
            assert.equal(call.traceId, accepted.jobId);
            calls.push(request.operation_id);
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
  for (const at of ["first_answer", "finish_answer"] as const) {
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
            assert.equal(name, at === "first_answer" ? "round 1 hold" : "round 2 hold");
            assert.equal(ms, 3000);
            await stop(f.job.jobId);
          },
        },
      );
      assert.deepEqual(end, { kind: "cancelled", ms: 0 });
      assert.equal(await f.state(), "cancelled");
      assert.deepEqual((await f.revisions())?.revisions, []);
      assert.deepEqual(f.wakes, [f.job.patternId]);
      assert(!engine.attempts.includes("record failure"));
      assert.equal(f.calls.length, at === "first_answer" ? 0 : 1);
      assert.equal(
        (await db.bucket.list()).objects.filter((o) => !before.has(o.key)).length,
        at === "first_answer" ? 2 : 8,
      );
    });
  }
  await t.test("a stop during geometry discards the arriving result", async () => {
    const f = await fixture();
    const end = await runJob(
      {
        ...f.deps,
        geometry: () => ({
          sampleDisplay() {
            throw new Error("Unexpected sampleDisplay");
          },
          async applyOperations() {
            await stop(f.job.jobId);
            return ok;
          },
        }),
      },
      f.job,
      stepEngine().steps,
    );
    assert.deepEqual(end, { kind: "cancelled", ms: 0 });
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
    assert.deepEqual(end, { kind: "cancelled", ms: 0 });
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
    assert.deepEqual(end, { kind: "cancelled", ms: 0 });
    assert.equal(await f.state(), "cancelled");
    assert.deepEqual(f.wakes, [f.job.patternId]);
  });
  await t.test("staging holds the verifier only and stopped jobs skip the hold", async () => {
    const f = await fixture();
    const hold = jobTestHoldSettingSchema.parse({
      ENVIRONMENT: "staging",
      JOB_TEST_HOLD: "first_answer:2",
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
  await t.test("commits one named revision and wakes once", async () => {
    const f = await fixture();
    const engine = stepEngine();
    const end = await runJob(f.deps, f.job, engine.steps);
    assert(end.kind === "committed");
    const page = await f.revisions();
    assert.equal(page?.revisions.length, 1);
    assert.equal(page.revisions[0]?.id, end.revisionId);
    assert.equal(page.revisions[0]?.name, "台本の案");
    assert.equal(page.revisions[0]?.baseRevisionId, null);
    assert.deepEqual(f.wakes, [f.job.patternId]);
    assert.deepEqual(engine.attempts, [
      "start job",
      "round 1 ai",
      "round 1 call 1 edit_house",
      "round 2 ai",
      "round 2 finish",
      "commit revision",
      "wake pattern",
    ]);
    assert.deepEqual(await runJob(f.deps, f.job, engine.steps), end);
    assert.deepEqual(f.wakes, [f.job.patternId], "cached steps never repeat side effects");
    const repeated = await runJob(f.deps, f.job, stepEngine().steps);
    assert.deepEqual(repeated, { kind: "committed", revisionId: end.revisionId });
    assert.equal(f.calls.length, 1, "a committed job skips the Container");
  });
  for (const mode of ["rerun", "loseResultsOnce"] as const) {
    await t.test(`stored turns survive ${mode} without another AI call`, async () => {
      const f = await fixture();
      const requests: AiRequest[] = [];
      const ai: Ai = {
        model: editingAi.model,
        roundTrip(request) {
          requests.push(request);
          return editingAi.roundTrip(request);
        },
      };
      const end = await runJob(
        { ...f.deps, ai },
        f.job,
        stepEngine({ [mode]: "round 1 ai" }).steps,
      );
      assert.equal(end.kind, "committed");
      assert.equal(requests.length, 2);
      const [first, second] = requests.map((r) => r.conversation);
      assert(first && second);
      assert.deepEqual({ ...second, rounds: [] }, first);
      assert.equal(second.rounds.length, 1);
      assert.deepEqual(first.opening, [{ kind: "text", text: "作って" }]);
      const versions = await db.raw
        .prepare("SELECT ai_model,ai_prompt_version,ai_tool_schema_version FROM jobs WHERE id=?")
        .bind(f.job.jobId)
        .first();
      assert.equal(versions?.["ai_model"], "scripted");
      assert.match(String(versions?.["ai_prompt_version"]), /^sha256:[0-9a-f]{64}$/u);
      assert.equal(versions?.["ai_tool_schema_version"], aiToolSchemaVersion);
      const explanation = await db.raw
        .prepare("SELECT body,number FROM messages WHERE job_id=? AND kind='explanation'")
        .bind(f.job.jobId)
        .first();
      assert.equal(explanation?.["body"], "説明\n\n仮置きした条件\n・平屋\n\n残る懸念\n・寸法");
      assert.equal(
        explanation?.["number"],
        await db.raw
          .prepare("SELECT conversation_number FROM revisions WHERE job_id=?")
          .bind(f.job.jobId)
          .first("conversation_number"),
      );
    });
  }
  await t.test("a stopped job makes no round trip", async () => {
    const f = await fixture();
    const engine = stepEngine();
    let calls = 0;
    const end = await runJob(
      {
        ...f.deps,
        ai: {
          model: "test",
          roundTrip(request) {
            calls++;
            return editingAi.roundTrip(request);
          },
        },
      },
      f.job,
      {
        ...engine.steps,
        async do(name, config, body) {
          if (name === "round 1 ai") await stop(f.job.jobId);
          return engine.steps.do(name, config, body);
        },
      },
    );
    assert.equal(end.kind, "cancelled");
    assert.equal(calls, 0);
  });
  await t.test("batches in one round have distinct operation IDs across retries", async () => {
    const f = await fixture();
    const call = (id: string) => ({
      kind: "tool_call" as const,
      name: "edit_house",
      id,
      inputJson: '{"operations":[{"kind":"remove_opening","id":"door"}]}',
    });
    const ai = scriptedAi([
      { stop: "tool_calls", parts: [call("one"), call("two")] },
      { stop: "refusal", parts: [{ kind: "text", text: "end" }] },
    ]);
    await runJob(
      { ...f.deps, ai },
      f.job,
      stepEngine({ loseResultsOnce: "round 1 call 2 edit_house" }).steps,
    );
    assert.deepEqual(
      f.calls,
      [".g1.r1.c1", ".g1.r1.c2", ".g1.r1.c2"].map((s) => f.job.jobId + s),
    );
  });
  await t.test("a call-less turn is nudged until the round limit", async () => {
    const f = await fixture();
    const ai = scriptedAi(() => ({ stop: "end", parts: [{ kind: "text", text: "draft" }] }));
    const engine = stepEngine();
    assert.deepEqual(await runJob({ ...f.deps, ai }, f.job, engine.steps), {
      kind: "failed",
      reason: "round_limit",
      ms: 0,
    });
    assert(engine.cache.has("round 24 ai"));
    assert.equal(await f.snapshots(), 0);
  });
  await t.test("a v1 base starts empty and commits the notice before the explanation", async () => {
    const patternId = await pattern();
    await accept(patternId);
    const claim = await claimNextJob(base, { patternId });
    assert(claim.kind === "claimed");
    const snapshot = await legacySnapshot(db.bucket, claim.right, Uint8Array.of(1), now);
    const previous = await completeJob(base, {
      right: claim.right,
      snapshot,
      name: "旧案",
      explanation: "旧案の説明",
    });
    assert(previous.kind === "committed");
    const f = await fixture([ok], patternId);
    assert.equal((await runJob(f.deps, f.job, stepEngine().steps)).kind, "committed");
    const messages = await db.raw
      .prepare("SELECT kind,body FROM messages WHERE job_id=? ORDER BY number")
      .bind(f.job.jobId)
      .all();
    assert.deepEqual(
      messages.results.map((m) => m["kind"]),
      ["notice", "explanation"],
    );
    assert.match(String(messages.results[0]?.["body"]), /空の住宅から作り直しました/u);
  });
  await t.test("four blocked finishes fail and preserve the earlier revision", async () => {
    const first = await fixture();
    const original = await runJob(first.deps, first.job, stepEngine().steps);
    assert(original.kind === "committed" && ok.kind === "ok" && ok.value.kind === "applied");
    const f = await fixture(
      [
        {
          ...ok,
          value: {
            ...ok.value,
            inspection: {
              housing: [{ element: "document", id: "house", reason: { kind: "no_entrance" } }],
              model: [],
            },
          },
        },
      ],
      first.job.patternId,
    );
    const ai = scriptedAi((view) => ({
      stop: "tool_calls",
      parts: [
        {
          kind: "tool_call",
          id: "finish-" + view.rounds.length,
          name: "finish",
          inputJson: JSON.stringify({
            answer: {
              kind: "plan",
              name: "案",
              explanation: "説明",
              assumptions: [],
              concerns: [],
            },
          }),
        },
      ],
    }));
    const engine = stepEngine();
    assert.deepEqual(await runJob({ ...f.deps, ai }, f.job, engine.steps), {
      kind: "failed",
      reason: "checks_unresolved",
      ms: 0,
    });
    assert.deepEqual(f.calls, [f.job.jobId + ".g1.r1.check"]);
    assert.equal(engine.attempts.filter((n) => n.endsWith(" finish")).length, 4);
    assert.deepEqual(
      (await f.revisions())?.revisions.map((r) => r.id),
      [original.revisionId],
    );
  });
  await t.test("a question and a mixed finish are tool errors and other calls run", async () => {
    const f = await fixture();
    const replies: AiRequest[] = [];
    const finish = {
      kind: "tool_call",
      id: "question",
      name: "finish",
      inputJson: JSON.stringify({
        answer: { kind: "question", question: "色は？", choices: ["赤", "青"] },
      }),
    } as const;
    const read = {
      kind: "tool_call",
      name: "read_house",
      id: "read",
      inputJson: '{"query":{"kind":"inspection"}}',
    } as const;
    const script = scriptedAi([
      { stop: "tool_calls", parts: [finish] },
      { stop: "tool_calls", parts: [{ ...finish, id: "mixed" }, read] },
      { stop: "refusal", parts: [{ kind: "text", text: "end" }] },
    ]);
    const ai: Ai = {
      model: script.model,
      roundTrip(request) {
        replies.push(request);
        return script.roundTrip(request);
      },
    };
    const end = await runJob({ ...f.deps, ai }, f.job, stepEngine().steps);
    assert.deepEqual(end, { kind: "failed", reason: "ai_refused", ms: 0 });
    const rounds = replies[2]?.conversation.rounds;
    const text = (r: number) => {
      const reply = rounds?.[r]?.reply;
      assert(reply?.kind === "tool_results");
      return reply.results.map((item) => {
        assert(item.isError);
        return item.content[0];
      });
    };
    assert.match(JSON.stringify(text(0)), /Questions are not available/u);
    assert.match(JSON.stringify(text(1)), /Call finish alone/u);
    assert.match(JSON.stringify(text(1)), /House is empty/u);
  });
  for (const reason of [
    "containers_disabled",
    "protocol_mismatch",
    "build_failed",
    "protocol_violation",
  ] as const) {
    await t.test(`${reason} fails permanently on the first render attempt`, async () => {
      const result: OperationsResult =
        reason === "containers_disabled" || reason === "protocol_mismatch"
          ? { kind: "unavailable", reason }
          : reason === "protocol_violation"
            ? { kind: "failed", reason, status: 200, violation: "content_type" }
            : { kind: "failed", reason, status: 500 };
      const f = await fixture([result]);
      const end = await runJob(f.deps, f.job, stepEngine().steps);
      assert.deepEqual(end, { kind: "failed", reason, ms: 0 });
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
      ms: 0,
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
      const engine = stepEngine({ rerun: "round 1 call 1 edit_house" });
      assert.equal((await runJob(f.deps, f.job, engine.steps)).kind, "committed");
      assert.deepEqual(f.calls, [f.job.jobId + ".g1.r1.c1", f.job.jobId + ".g1.r1.c1"]);
      const manifests = (await db.bucket.list()).objects.filter(
        (object) => !before.has(object.key) && object.key.endsWith("manifest.json"),
      );
      assert.equal(manifests.length, 2);
      assert.equal(await f.snapshots(), 1);
      const saved = engine.cache.get("round 1 call 1 edit_house");
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
      ms: 0,
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

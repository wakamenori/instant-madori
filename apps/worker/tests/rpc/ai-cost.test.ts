import { scriptedAi } from "../../src/ai/scripted.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "../../src/ai/round-trip.ts";
import { limits, microUsd } from "../../src/limits.ts";
import { estimateAttempt } from "../../src/services/cost.ts";
import { meteredRoundTrip } from "../../src/services/ai-cost.ts";
import { acceptInstruction, claimNextJob, stopJob } from "../../src/services/jobs.ts";
import type { JobExecutionRight } from "../../src/storage/job-execution.ts";
import type { Store } from "../../src/storage/store.ts";
import { openJobDatabase, applyJobMigrations, now } from "./jobs-support.ts";

type StoredUsage = Parameters<Store["aiCost"]["settle"]>[1]["usage"];
type SameKeys<A, B> = [keyof A, keyof B] extends [keyof B, keyof A] ? A : never;
const usage: SameKeys<Usage, StoredUsage> = {
  uncachedInputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWrite5mTokens: 4,
  cacheWrite1hTokens: 5,
};
const reserved = { kind: "reserved" };
const jobLimit = { kind: "limited", limit: "perInstruction" };
const monthLimit = { kind: "limited", limit: "monthly" };
const cap = limits.aiCost.perInstruction;

await test("AI attempt costs on real D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("cost");
  const deps = { store: db.store, runtime: db.runtime, wakePattern: async () => {} };
  async function runningJob() {
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
        firstPattern: { id: crypto.randomUUID(), name: "T", defaultNamePrefix: "T" },
      },
    );
    assert(project.kind === "applied");
    const patternId = project.result.pattern.id;
    assert.equal(
      (
        await acceptInstruction(deps, {
          ownerId,
          patternId,
          requestId: crypto.randomUUID(),
          body: "案を作って",
        })
      ).kind,
      "accepted",
    );
    const job = await claimNextJob(deps, { patternId });
    assert(job.kind === "claimed");
    return job.right;
  }
  function reserve(
    right: JobExecutionRight,
    amount: number,
    at: string,
    attemptId: string = crypto.randomUUID(),
  ) {
    return db.store.aiCost.reserve(right, {
      attemptId,
      reserve: microUsd(amount),
      estimatedInputTokens: 10,
      estimatedOutputTokens: 5,
      now: at,
    });
  }
  function settle(right: JobExecutionRight, attemptId: string, amount: number, at: string) {
    return db.store.aiCost.settle(right.reference, {
      attemptId,
      charge: microUsd(amount),
      usage,
      now: at,
    });
  }
  async function stop(right: JobExecutionRight) {
    const result = await stopJob(deps, {
      ownerId,
      requestId: crypto.randomUUID(),
      jobId: right.reference.jobId,
    });
    assert(result.kind === "stop");
    assert.equal(result.result.outcome, "stopped");
  }
  await t.test(
    "concurrent jobs fill the month exactly; late settlement credits the reservation month",
    async () => {
      const end = "2026-01-31T23:59:59.999Z";
      const start = "2026-02-01T00:00:00.000Z";
      const jobs = await Promise.all(
        Array.from({ length: 21 }, async () => ({
          right: await runningJob(),
          id: crypto.randomUUID(),
        })),
      );
      const results = await Promise.all(
        jobs.map(async (job) => ({ ...job, result: await reserve(job.right, cap, end, job.id) })),
      );
      assert.equal(results.filter((r) => r.result.kind === "reserved").length, 20);
      assert.deepEqual(
        results.filter((r) => r.result.kind !== "reserved").map((r) => r.result),
        [monthLimit],
      );
      const next = await runningJob();
      assert.deepEqual(await reserve(next, 1, end), monthLimit);
      const winner = results.find((r) => r.result.kind === "reserved");
      assert(winner);
      assert.deepEqual(await reserve(winner.right, 1, end), jobLimit);
      assert.deepEqual(await reserve(next, 1, start), reserved);
      await stop(winner.right);
      await settle(winner.right, winner.id, cap - 100, start);
      assert.deepEqual(await reserve(next, 100, end), reserved);
      assert.deepEqual(await reserve(next, 1, end), monthLimit);
      const february = await Promise.all(Array.from({ length: 20 }, runningJob));
      const fills = await Promise.all(
        february.map((right, index) => reserve(right, index === 0 ? cap - 1 : cap, start)),
      );
      assert.deepEqual(
        fills,
        february.map(() => reserved),
      );
      assert.deepEqual(await reserve(next, 1, start), monthLimit);
    },
  );
  await t.test("six simultaneous one-dollar attempts fill one job", async () => {
    const at = "2026-03-01T00:00:00.000Z";
    const right = await runningJob();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reserve(right, 1_000_000, at)),
    );
    assert.equal(results.filter((r) => r.kind === "reserved").length, 5);
    assert.deepEqual(
      results.filter((r) => r.kind !== "reserved"),
      [jobLimit],
    );
    assert.deepEqual(await reserve(right, 1, at), jobLimit);
    assert.deepEqual(await reserve(await runningJob(), 1, at), reserved);
  });
  await t.test(
    "settled charges replace estimates, including overages; unknown usage keeps its reserve",
    async () => {
      const at = "2026-04-01T00:00:00.000Z";
      for (const [amount, charge] of [
        [cap, 123],
        [1, 200],
      ] as const) {
        const right = await runningJob();
        const id = crypto.randomUUID();
        assert.deepEqual(await reserve(right, amount, at, id), reserved);
        await settle(right, id, charge, at);
        await settle(right, id, charge, at);
        await assert.rejects(settle(right, id, charge + 1, at), /settlement conflicts/);
        await assert.rejects(settle(right, crypto.randomUUID(), charge, at), /attempt missing/);
        await assert.rejects(
          db.store.aiCost.settle(right.reference, {
            attemptId: id,
            charge: microUsd(charge),
            usage: { ...usage, outputTokens: 0 },
            now: at,
          }),
          /settlement conflicts/,
        );
        assert.deepEqual(await reserve(right, cap - charge, at), reserved);
        assert.deepEqual(await reserve(right, 1, at), jobLimit);
      }
    },
  );
  await t.test("replayed reservations count once and a stopped job cannot replay", async () => {
    const at = "2026-05-01T00:00:00.000Z";
    const right = await runningJob();
    const id = crypto.randomUUID();
    assert.deepEqual(await Promise.all([reserve(right, 2, at, id), reserve(right, 2, at, id)]), [
      reserved,
      reserved,
    ]);
    await assert.rejects(reserve(right, 1, at, id), /id_reused/);
    assert.deepEqual(await reserve(right, cap - 2, at), reserved);
    assert.deepEqual(await reserve(right, 1, at), jobLimit);
    await stop(right);
    assert.deepEqual(await reserve(right, 2, at, id), { kind: "execution_lost" });
    assert.deepEqual(await reserve(right, 1, at), { kind: "execution_lost" });
  });
  await t.test(
    "service reserves its estimate per call and settles its calculated charge",
    async () => {
      const right = await runningJob();
      const request = {
        conversation: {
          system: "hello",
          tools: [],
          opening: [{ kind: "text" as const, text: "hello" }],
          rounds: [],
        },
        maxOutputTokens: 100,
      };
      const estimate = estimateAttempt(request);
      const ai = scriptedAi([{ stop: "end", parts: [{ kind: "text", text: "answer" }], usage }]);
      for (let call = 0; call < 2; call++) {
        assert.equal((await meteredRoundTrip({ ...deps, ai }, right, request)).kind, "ok");
      }
      const amounts = await db.raw
        .prepare("SELECT reserved, charged FROM ai_attempts WHERE job_id = ?")
        .bind(right.reference.jobId)
        .all();
      // 10 input, 2 output, 3 cache reads, 4 short writes and 5 long writes, rounded up.
      assert.deepEqual(
        amounts.results,
        Array(2).fill({ reserved: estimate.reserve, charged: 141 }),
      );
    },
  );
});

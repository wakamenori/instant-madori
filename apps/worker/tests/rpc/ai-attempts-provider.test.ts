import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { anthropicAi } from "../../src/ai/anthropic.ts";
import { turnCodec } from "../../src/ai/turns.ts";
import { runJob } from "../../src/services/jobs.ts";
import { contentBlock, recordedStream, sse } from "../support/anthropic-sse.ts";
import { stepEngine } from "./job-steps.ts";
import { applyJobMigrations, openJobDatabase, snapshotPattern } from "./jobs-support.ts";

const attemptLog = z.object({
  event: z.literal("ai.attempt"),
  jobId: z.string(),
  generation: z.number(),
  attemptId: z.string(),
  outcome: z.enum(["unsettled", "settled"]),
  aiMs: z.number().nonnegative(),
  reservedMicroUsd: z.number().positive(),
  chargedMicroUsd: z.number().optional(),
  uncachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWrite5mTokens: z.number().optional(),
  cacheWrite1hTokens: z.number().optional(),
  error: z.string().optional(),
  providerStatus: z.number().optional(),
  providerError: z.string().optional(),
  providerRequestId: z.string().optional(),
});

await test("Workflow retries reserve a separate D1 attempt before every provider request", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const { claim } = await snapshotPattern(db);
  const { reference: job } = await claim();
  const counts: number[] = [];

  const ai = anthropicAi({
    model: "claude-opus-5-5",
    apiKey: "fake-test-key",
    async fetch() {
      const count = await db.raw
        .prepare("SELECT count(*) AS attempts FROM ai_attempts WHERE job_id = ?")
        .bind(job.jobId)
        .first<number>("attempts");
      assert(count !== null);
      counts.push(count);
      if (counts.length === 1) throw new TypeError("connection closed");
      if (counts.length === 2) return new Response("overloaded", { status: 529 });
      return sse(
        recordedStream({
          stopReason: "refusal",
          blocks: [contentBlock(0, { type: "text", text: "discard this refusal body" })],
        }),
      );
    },
  });

  const logs: unknown[] = [];
  const capture = (...values: unknown[]) => {
    const [line] = values;
    if (typeof line !== "string") return;
    const result = attemptLog.safeParse(JSON.parse(line));
    if (result.success) logs.push(result.data);
  };
  t.mock.method(console, "log", capture);
  t.mock.method(console, "error", capture);
  const deps = {
    store: db.store,
    runtime: db.runtime,
    turns: turnCodec,
    ai: {
      forNewJob: () => Promise.resolve(ai),
      continuing(model: string) {
        assert.equal(model, "claude-opus-5-5");
        return ai;
      },
    },
    geometry: () => assert.fail("a refusal cannot run geometry"),
    testHold: null,
    wakePattern: async () => {},
  };
  const engine = stepEngine();
  const outcome = await runJob(deps, job, engine.steps);

  assert.equal(outcome.kind === "failed" && outcome.reason, "ai_refused");
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(engine.attempts.filter((step) => step === "round 1 ai").length, 3);

  const attempts = await db.raw
    .prepare(
      "SELECT id, reserved, charged, counted FROM ai_attempts WHERE job_id = ? ORDER BY rowid",
    )
    .bind(job.jobId)
    .all<{ id: string; reserved: number; charged: number | null; counted: number }>();
  const [first, second, third] = attempts.results;
  assert(first && second && third);
  assert.equal(attempts.results.length, counts.length);
  for (const attempt of [first, second]) {
    assert(attempt.reserved > 0);
    assert.equal(attempt.charged, null);
    assert.equal(attempt.counted, attempt.reserved);
  }
  assert.equal(third.charged, 93_401);
  assert.equal(third.counted, 93_401);

  const common = { jobId: job.jobId, generation: job.generation, event: "ai.attempt", aiMs: 0 };
  assert.deepEqual(logs, [
    {
      ...common,
      attemptId: first.id,
      reservedMicroUsd: first.reserved,
      outcome: "unsettled",
      error: "Error: Anthropic attempt interrupted (connection)",
    },
    {
      ...common,
      attemptId: second.id,
      reservedMicroUsd: second.reserved,
      outcome: "unsettled",
      error: "Error: Anthropic attempt interrupted (api HTTP 529)",
    },
    {
      ...common,
      attemptId: third.id,
      reservedMicroUsd: third.reserved,
      outcome: "settled",
      chargedMicroUsd: 93_401,
      uncachedInputTokens: 1_200,
      outputTokens: 3_500,
      cacheReadTokens: 3_003,
      cacheWrite5mTokens: 2_000,
      cacheWrite1hTokens: 1_000,
    },
  ]);

  const { reference: nextJob } = await (await snapshotPattern(db)).claim();
  const unusable = anthropicAi({
    model: "claude-opus-5-5",
    apiKey: "fake-test-key",
    fetch: () => Promise.resolve(sse(recordedStream({ stopReason: "pause_turn" }))),
  });
  const rejected = await runJob(
    {
      ...deps,
      ai: { forNewJob: () => Promise.resolve(unusable), continuing: () => unusable },
    },
    nextJob,
    stepEngine().steps,
  );
  assert.equal(rejected.kind === "failed" && rejected.reason, "ai_rejected");
  assert.deepEqual(
    (
      await db.raw
        .prepare("SELECT charged FROM ai_attempts WHERE job_id = ?")
        .bind(nextJob.jobId)
        .all()
    ).results,
    [{ charged: 93_401 }],
  );

  const { reference: refusedJob } = await (await snapshotPattern(db)).claim();
  const refusing = anthropicAi({
    model: "claude-opus-5-5",
    apiKey: "fake-test-key",
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "private provider message" },
          }),
          { status: 400, headers: { "request-id": "req_011Refused" } },
        ),
      ),
  });
  logs.length = 0;
  const refused = await runJob(
    {
      ...deps,
      ai: { forNewJob: () => Promise.resolve(refusing), continuing: () => refusing },
    },
    refusedJob,
    stepEngine().steps,
  );
  assert.equal(refused.kind === "failed" && refused.reason, "ai_rejected");
  assert.deepEqual(
    logs.map((line) =>
      attemptLog
        .pick({
          outcome: true,
          chargedMicroUsd: true,
          providerStatus: true,
          providerError: true,
          providerRequestId: true,
        })
        .parse(line),
    ),
    [
      {
        outcome: "settled",
        chargedMicroUsd: 0,
        providerStatus: 400,
        providerError: "invalid_request_error",
        providerRequestId: "req_011Refused",
      },
    ],
  );
});

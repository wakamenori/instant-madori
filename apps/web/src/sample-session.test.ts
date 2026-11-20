import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  acceptInstructionRequestSchema,
  displayContentType,
  type PatternStateResponse,
} from "@madori/contracts";
import { ApiError } from "./api.ts";
import {
  failureMessage,
  judgeJob,
  runSample,
  sampleInstruction,
  SampleStorageError,
  startNewInstruction,
  type SampleStep,
} from "./sample-session.ts";

const uuid = () => crypto.randomUUID();
const createdAt = "2026-01-01T00:00:00Z";
const project = { id: uuid(), name: "project", version: 1, createdAt, updatedAt: createdAt };
const pattern = { ...project, id: uuid(), projectId: project.id };
const revision = {
  id: uuid(),
  patternId: pattern.id,
  number: 1,
  name: "sample",
  baseRevisionId: null,
  createdAt,
};
const job = { jobId: uuid(), messageId: uuid(), number: 3 };
const earlier = { jobId: uuid(), messageId: uuid(), number: 2 };
const later = { jobId: uuid(), messageId: uuid(), number: 4 };
const state: PatternStateResponse = {
  pattern,
  currentRevision: null,
  runningJob: null,
  queuedJobs: [],
  queueHold: null,
  lastFinishedJob: null,
};
const completed = { ...job, state: "completed" as const, revision };
const failed = { ...job, state: "failed" as const };
const cancelled = { ...job, state: "cancelled" as const };
const done = { ...state, currentRevision: revision, lastFinishedJob: completed };
const bytes = new Uint8Array([3, 2, 1]);
const view = { revision, display: bytes };

void test("judgeJob follows the accepted job and uses the current revision", () => {
  const cases: [Partial<PatternStateResponse>, ReturnType<typeof judgeJob>][] = [
    [{ runningJob: job }, { kind: "running" }],
    [{ queuedJobs: [job] }, { kind: "queued", ahead: 0 }],
    [
      { runningJob: { ...earlier, jobId: uuid() }, queuedJobs: [earlier, job] },
      { kind: "queued", ahead: 2 },
    ],
    [
      { currentRevision: revision, lastFinishedJob: completed },
      { kind: "done", revision },
    ],
    [{ lastFinishedJob: completed }, { kind: "missing" }],
    [
      { currentRevision: revision, lastFinishedJob: cancelled },
      { kind: "stopped", revision },
    ],
    [{ lastFinishedJob: cancelled }, { kind: "stopped", revision: null }],
    [
      { currentRevision: revision, lastFinishedJob: failed },
      { kind: "failed", revision },
    ],
    [{ lastFinishedJob: failed }, { kind: "failed", revision: null }],
    [
      { currentRevision: revision, lastFinishedJob: { ...failed, ...later } },
      { kind: "done", revision },
    ],
    [{ lastFinishedJob: { ...cancelled, ...later } }, { kind: "failed", revision: null }],
    [{ lastFinishedJob: { ...failed, ...earlier } }, { kind: "missing" }],
    [{}, { kind: "missing" }],
  ];
  for (const [fields, expected] of cases)
    assert.deepEqual(judgeJob({ ...state, ...fields }, job), expected);
});

const key = "instant-madori.dev-sample";
const projectPost = "POST /api/projects";
const instructionPost = `POST /api/patterns/${pattern.id}/messages`;
const stateGet = `GET /api/patterns/${pattern.id}/state`;
const viewGet = `GET /api/revisions/${revision.id}/view`;

function acceptance() {
  return [
    Response.json({ project, pattern }, { status: 201 }),
    Response.json({ job }, { status: 202 }),
  ];
}
function viewResponse() {
  return new Response(bytes, {
    headers: { "content-type": displayContentType, "x-revision-id": revision.id },
  });
}
function harness(t: TestContext) {
  const data = new Map<string, string>();
  const events: string[] = [];
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      events.push("save");
      data.set(key, value);
    },
  };
  const replies: Response[] = [];
  const posts: string[] = [];
  const waits: number[] = [];
  const steps: SampleStep[] = [];
  t.mock.method(globalThis, "fetch", (path: string, init: RequestInit) => {
    events.push(`${init.method ?? "GET"} ${path}`);
    if (init.method === "POST") {
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      assert.ok(typeof init.body === "string");
      posts.push(init.body);
    }
    const reply = replies.shift();
    assert.ok(reply, `unexpected request for ${path}`);
    return Promise.resolve(reply);
  });
  const run = (signal = new AbortController().signal) =>
    runSample({
      signal,
      storage,
      onStep: (step) => steps.push(step),
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
  return { run, storage, data, events, posts, replies, waits, steps };
}

void test("polls queued and running states then reads the committed view exactly once", async (t) => {
  const h = harness(t);
  h.replies.push(
    ...acceptance(),
    Response.json({ ...state, queuedJobs: [job] }),
    Response.json({ ...state, runningJob: job }),
    Response.json(done),
    viewResponse(),
  );
  assert.deepEqual(await h.run(), { kind: "done", view });
  assert.deepEqual(h.events, [
    "save",
    projectPost,
    instructionPost,
    stateGet,
    stateGet,
    stateGet,
    viewGet,
  ]);
  assert.deepEqual(h.waits, [1000, 1000]);
  assert.deepEqual(h.steps, [
    { kind: "preparing" },
    { kind: "queued", ahead: 0 },
    { kind: "running" },
    { kind: "loading_view", revision },
  ]);
});

void test("reload replays byte-identical requests and draws without waiting", async (t) => {
  const h = harness(t);
  for (let run = 0; run < 2; run++) {
    h.replies.push(...acceptance(), Response.json(done), viewResponse());
    assert.deepEqual(await h.run(), { kind: "done", view });
  }
  const requests = [projectPost, instructionPost, stateGet, viewGet];
  assert.deepEqual(h.events, ["save", ...requests, ...requests]);
  assert.deepEqual(h.posts.slice(2), h.posts.slice(0, 2));
  assert.deepEqual(h.waits, []);
});

void test("StrictMode remount reuses the interrupted project request", async (t) => {
  const h = harness(t);
  h.replies.push(
    Response.json({ project, pattern }),
    ...acceptance(),
    Response.json(done),
    viewResponse(),
  );
  const controller = new AbortController();
  const first = h.run(controller.signal);
  assert.deepEqual(h.events, ["save", projectPost]);
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.deepEqual(h.steps, [{ kind: "preparing" }]);
  await h.run();
  assert.equal(h.posts[1], h.posts[0]);
});

void test("overlapping runs share both request IDs before either receives a response", async (t) => {
  const h = harness(t);
  h.replies.push(Response.json({ project, pattern }), Response.json({ project, pattern }));
  const first = h.run();
  const second = h.run();
  assert.deepEqual(h.events, ["save", projectPost, projectPost]);
  assert.equal(h.posts[0], h.posts[1]);
  h.replies.push(
    Response.json({ job }),
    Response.json({ job }),
    Response.json(done),
    Response.json(done),
    viewResponse(),
    viewResponse(),
  );
  await Promise.all([first, second]);
  assert.equal(h.posts.length, 4);
  assert.equal(h.posts[2], h.posts[3]);
});

void test("an earlier job's revision does not end polling for the queued job", async (t) => {
  const h = harness(t);
  const previous = { ...revision, id: uuid() };
  h.replies.push(
    ...acceptance(),
    Response.json({
      ...state,
      currentRevision: previous,
      lastFinishedJob: { ...earlier, state: "completed", revision: previous },
      queuedJobs: [job],
    }),
    Response.json(done),
    viewResponse(),
  );
  assert.deepEqual(await h.run(), { kind: "done", view });
  assert.deepEqual(h.events, ["save", projectPost, instructionPost, stateGet, stateGet, viewGet]);
});

void test("a later cancellation without a revision cannot mark the accepted job stopped", async (t) => {
  const h = harness(t);
  h.replies.push(
    ...acceptance(),
    Response.json({ ...state, lastFinishedJob: { ...cancelled, ...later } }),
  );
  assert.deepEqual(await h.run(), { kind: "failed", view: null });
});

void test("retry after a message POST failure replays the instruction", async (t) => {
  const h = harness(t);
  h.replies.push(
    Response.json({ project, pattern }),
    Response.json({ error: "internal_error" }, { status: 500 }),
  );
  await assert.rejects(h.run(), new ApiError("internal_error"));
  h.replies.push(...acceptance(), Response.json(done), viewResponse());
  await h.run();
  assert.equal(h.posts[1], h.posts[3]);
});

void test("failed jobs persist across reloads and only send again replaces the instruction", async (t) => {
  const h = harness(t);
  for (let run = 0; run < 2; run++) {
    h.replies.push(...acceptance(), Response.json({ ...state, lastFinishedJob: failed }));
    assert.deepEqual(await h.run(), { kind: "failed", view: null });
  }
  assert.deepEqual(h.events, [
    "save",
    projectPost,
    instructionPost,
    stateGet,
    projectPost,
    instructionPost,
    stateGet,
  ]);
  assert.deepEqual(h.posts.slice(2), h.posts.slice(0, 2));
  startNewInstruction(h.storage);
  h.replies.push(
    Response.json({ project, pattern }),
    Response.json({ error: "service_unavailable" }, { status: 503 }),
  );
  await assert.rejects(h.run(), new ApiError("service_unavailable"));
  const instruction = (index: number) =>
    acceptInstructionRequestSchema.parse(JSON.parse(h.posts[index] ?? ""));
  assert.equal(h.posts[4], h.posts[0]);
  assert.notEqual(instruction(5).requestId, instruction(1).requestId);
  assert.equal(instruction(5).body, sampleInstruction);
  h.replies.push(...acceptance(), Response.json(done), viewResponse());
  await h.run();
  assert.deepEqual(h.posts.slice(6), h.posts.slice(4, 6));
});

void test("a stopped job draws the earlier committed revision", async (t) => {
  const h = harness(t);
  h.replies.push(
    ...acceptance(),
    Response.json({ ...done, lastFinishedJob: cancelled }),
    viewResponse(),
  );
  assert.deepEqual(await h.run(), { kind: "stopped", view });
  assert.deepEqual(h.events, ["save", projectPost, instructionPost, stateGet, viewGet]);
});

void test("corrupt stored requests are replaced before sending", async (t) => {
  const h = harness(t);
  const valid = {
    project: { requestId: uuid() },
    instruction: { requestId: uuid(), body: "stored" },
  };
  for (const raw of [
    "bad JSON",
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, project: { requestId: "invalid" } }),
  ]) {
    h.data.set(key, raw);
    h.replies.push(...acceptance(), Response.json(done), viewResponse());
    await h.run();
    const saved = h.data.get(key);
    assert.ok(saved && saved !== raw);
    assert.deepEqual(JSON.parse(saved), {
      project: JSON.parse(h.posts.at(-2) ?? "") as unknown,
      instruction: JSON.parse(h.posts.at(-1) ?? "") as unknown,
    });
  }
});

void test("blocked storage prevents all requests unless replay IDs already exist", async (t) => {
  const h = harness(t);
  h.storage.setItem = () => {
    throw new Error("blocked");
  };
  await assert.rejects(h.run(), SampleStorageError);
  assert.deepEqual(h.events, []);
  assert.equal(
    failureMessage(new SampleStorageError()),
    "ブラウザに保存できないため、サンプルを用意できません。",
  );
  h.data.set(
    key,
    JSON.stringify({
      project: { requestId: uuid() },
      instruction: { requestId: uuid(), body: "stored" },
    }),
  );
  h.replies.push(...acceptance(), Response.json(done), viewResponse());
  await h.run();
  assert.deepEqual(h.events, [projectPost, instructionPost, stateGet, viewGet]);
});

void test("retry after a state poll failure replays both requests", async (t) => {
  const h = harness(t);
  h.replies.push(
    ...acceptance(),
    Response.json(
      { error: "service_unavailable" },
      { status: 503, headers: { "retry-after": "5" } },
    ),
  );
  await assert.rejects(h.run(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.retryAfter, 5);
    assert.equal(
      failureMessage(error),
      "形状サービスを利用できません。しばらくしてから再試行してください。",
    );
    return true;
  });
  assert.deepEqual(h.events, ["save", projectPost, instructionPost, stateGet]);
  h.replies.push(...acceptance(), Response.json(done), viewResponse());
  assert.deepEqual(await h.run(), { kind: "done", view });
  assert.deepEqual(h.posts.slice(2), h.posts.slice(0, 2));
});

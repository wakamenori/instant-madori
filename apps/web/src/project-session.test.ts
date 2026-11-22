import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { displayContentType, type PatternStateResponse } from "@madori/contracts";
import { createProject } from "./api.ts";
import { parseRoute, formatRoute, parseProjectId, projectRoute } from "./route.ts";
import { watchProject, summarizeActivity, type ProjectView } from "./project-session.ts";

const createdAt = "2026-11-22T00:00:00Z";
const project = {
  id: crypto.randomUUID(),
  name: "新しい案件",
  version: 1,
  createdAt,
  updatedAt: createdAt,
};
const pattern = { ...project, id: crypto.randomUUID(), projectId: project.id };
const job = { jobId: crypto.randomUUID(), messageId: crypto.randomUUID(), number: 1 };
const held = { ...job, state: "failed" as const };
const revision = {
  id: crypto.randomUUID(),
  patternId: pattern.id,
  number: 1,
  name: "初案",
  baseRevisionId: null,
  createdAt,
};
const next = { ...revision, id: crypto.randomUUID(), number: 2 };
const state: PatternStateResponse = {
  pattern,
  currentRevision: revision,
  queuedJobs: [],
  runningJob: null,
  queueHold: null,
  lastFinishedJob: null,
};
const signal = new AbortController().signal;
function display(id: string) {
  return new Response(new Uint8Array([3]), {
    headers: { "content-type": displayContentType, "x-revision-id": id },
  });
}
function requests(t: TestContext, responses: Response[]) {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", (path: string, init: RequestInit) => {
    paths.push(`${init.method ?? "GET"} ${path}`);
    const response = responses.shift();
    assert.ok(response);
    return Promise.resolve(response);
  });
  return paths;
}

void test("the created project opens on its first pattern and polls until idle", async (t) => {
  const paths = requests(t, [
    Response.json({ project, pattern }, { status: 201 }),
    Response.json({ patterns: [pattern, { ...pattern, id: crypto.randomUUID() }] }),
    Response.json({ ...state, queuedJobs: [job] }),
    display(revision.id),
    Response.json({ ...state, runningJob: job }),
    Response.json({ ...state, currentRevision: next }),
    display(next.id),
  ]);
  const created = await createProject({ requestId: crypto.randomUUID() }, signal);
  assert.deepEqual(created, { project, pattern });
  const route = parseRoute(formatRoute(projectRoute(parseProjectId(created.project.id))));
  assert.equal(route.kind, "project");
  const views: ProjectView[] = [];
  const waits: number[] = [];
  await watchProject({
    projectId: route.projectId,
    signal,
    onView: (view) => views.push(view),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  const statePath = `GET /api/patterns/${pattern.id}/state`;
  assert.deepEqual(paths, [
    "POST /api/projects",
    `GET /api/projects/${project.id}/patterns`,
    statePath,
    `GET /api/revisions/${revision.id}/view`,
    statePath,
    statePath,
    `GET /api/revisions/${next.id}/view`,
  ]);
  assert.deepEqual(waits, [1000, 1000]);
  assert.deepEqual(views.at(-1), {
    kind: "open",
    pattern,
    activity: { kind: "idle" },
    shown: { revision: next, display: new Uint8Array([3]) },
    problem: null,
  });
});

void test("a held queue stops polling even with jobs waiting", async (t) => {
  const paths = requests(t, [
    Response.json({ patterns: [pattern] }),
    Response.json({ ...state, currentRevision: null, queueHold: { job: held }, queuedJobs: [job] }),
  ]);
  const views: ProjectView[] = [];
  await watchProject({
    projectId: parseProjectId(project.id),
    signal,
    onView: (v) => views.push(v),
    wait: () => Promise.reject(new Error("unexpected wait")),
  });
  assert.equal(paths.length, 2);
  assert.deepEqual(views, [
    {
      kind: "open",
      pattern,
      activity: { kind: "held", job: held, queued: 1 },
      shown: null,
      problem: null,
    },
  ]);
});

void test("missing and empty pattern lists report distinct failures", async (t) => {
  requests(t, [
    Response.json({ error: "not_found" }, { status: 404 }),
    Response.json({ patterns: [] }),
  ]);
  const views: ProjectView[] = [];
  const options = {
    projectId: parseProjectId(project.id),
    signal,
    onView: (v: ProjectView) => views.push(v),
  };
  await watchProject(options);
  await watchProject(options);
  assert.deepEqual(views, [
    { kind: "not_found" },
    { kind: "failed", message: "読み込みに失敗しました。" },
  ]);
});

void test("a polling failure leaves the last revision visible", async (t) => {
  requests(t, [
    Response.json({ patterns: [pattern] }),
    Response.json({ ...state, runningJob: job }),
    display(revision.id),
    new Response("", { status: 500 }),
  ]);
  const views: ProjectView[] = [];
  await watchProject({
    projectId: parseProjectId(project.id),
    signal,
    onView: (v) => views.push(v),
    wait: () => Promise.resolve(),
  });
  assert.equal(views.length, 2);
  const open = views[0];
  assert.ok(open?.kind === "open" && open.shown?.revision.id === revision.id);
  assert.deepEqual(views[1], { ...open, problem: "読み込みに失敗しました。" });
});

void test("held, running, queued and idle activity have descending precedence", () => {
  const busy = { ...state, queuedJobs: [job], runningJob: job };
  assert.deepEqual(summarizeActivity({ ...busy, queueHold: { job: held } }), {
    kind: "held",
    job: held,
    queued: 1,
  });
  assert.deepEqual(summarizeActivity(busy), { kind: "working", queued: 1 });
  assert.deepEqual(summarizeActivity({ ...busy, runningJob: null }), { kind: "queued", count: 1 });
  assert.deepEqual(summarizeActivity(state), { kind: "idle" });
});

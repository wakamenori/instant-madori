import { checkInstruction } from "./conversation.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  displayContentType,
  floorPlanStoreysHeader,
  renameRequestSchema,
  type RenameRequest,
  type PatternStateResponse,
} from "@madori/contracts";
import { createProject } from "./api.ts";
import { parseRoute, formatRoute, parseProjectId, projectRoute } from "./route.ts";
import { createProjectSession, summarizeActivity } from "./project-session.ts";

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
function display(id: string, storeys = "", byte = 3) {
  return new Response(new Uint8Array([byte]), {
    headers: {
      "content-type": displayContentType,
      "x-revision-id": id,
      [floorPlanStoreysHeader]: storeys,
    },
  });
}
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

const projectPath = `/api/projects/${project.id}`;
const patternPath = `/api/patterns/${pattern.id}`;
const patternsPath = `GET /api/projects/${project.id}/patterns`;
const statePath = `GET /api/patterns/${pattern.id}/state`;
const messagesPath = `/api/patterns/${pattern.id}/messages`;
const row = {
  id: job.messageId,
  jobId: job.jobId,
  number: 1,
  kind: "instruction",
  attachmentIds: [],
  createdAt,
  revision: null,
  body: "窓を広げる",
};
function body(text = row.body) {
  const checked = checkInstruction(text);
  assert.ok(checked.ok);
  return checked.body;
}
type Handler = (init: RequestInit) => Response | Promise<Response>;
function router(t: TestContext, overrides: Record<string, Handler>) {
  const paths: string[] = [];
  const routes: Record<string, Handler> = {
    [`GET ${projectPath}`]: () => Response.json({ project }),
    [patternsPath]: () => Response.json({ patterns: [pattern] }),
    [statePath]: () => Response.json({ ...state, currentRevision: null }),
    [`GET ${messagesPath}`]: () => Response.json({ messages: [], nextCursor: null }),
    ...overrides,
  };
  t.mock.method(globalThis, "fetch", (path: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${path}`;
    paths.push(key);
    const handler = routes[key];
    assert.ok(handler, key);
    return handler(init);
  });
  return paths;
}
function start(t: TestContext, deps?: Parameters<typeof createProjectSession>[1]) {
  const session = createProjectSession(parseProjectId(project.id), deps);
  t.after(session.start());
  return session;
}
function openView(session: ReturnType<typeof createProjectSession>) {
  const view = session.getView();
  assert.equal(view.kind, "open");
  return view;
}

void test("the created project opens its first pattern and polls through queued and working to idle", async (t) => {
  const states = [
    { ...state, queuedJobs: [job] },
    { ...state, runningJob: job },
    { ...state, currentRevision: next },
  ];
  const paths = router(t, {
    "POST /api/projects": () => Response.json({ project, pattern }, { status: 201 }),
    [patternsPath]: () =>
      Response.json({ patterns: [pattern, { ...pattern, id: crypto.randomUUID() }] }),
    [statePath]: () => Response.json(states.shift()),
    [`GET /api/revisions/${revision.id}/view`]: () => display(revision.id),
    [`GET /api/revisions/${next.id}/view`]: () => display(next.id),
  });
  const created = await createProject({ requestId: crypto.randomUUID() }, signal);
  const route = parseRoute(formatRoute(projectRoute(parseProjectId(created.project.id))));
  assert.equal(route.kind, "project");
  const waits: number[] = [];
  const session = createProjectSession(route.projectId, {
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  t.after(session.start());
  await t.waitFor(() => assert.ok(openView(session).shown?.revision.id === next.id));
  assert.deepEqual(openView(session).shown, {
    revision: next,
    display: new Uint8Array([3]),
    plan: { kind: "absent" },
  });
  assert.ok(!paths.some((path) => path.includes("floor-plan")));
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(paths.filter((p) => p === `GET /api/revisions/${revision.id}/view`).length, 1);
});
void test("a held queue sleeps with jobs waiting", async (t) => {
  router(t, {
    [statePath]: () =>
      Response.json({
        ...state,
        currentRevision: null,
        queueHold: { job: held },
        queuedJobs: [job],
      }),
  });
  const waits: number[] = [];
  const session = start(t, {
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  await t.waitFor(() => assert.ok(openView(session).activity.kind === "held"));
  assert.deepEqual(waits, []);
});
void test("missing and empty pattern lists report distinct failures", async (t) => {
  let missing = true;
  router(t, {
    [patternsPath]: () =>
      missing
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ patterns: [] }),
  });
  const first = start(t);
  await t.waitFor(() => assert.ok(first.getView().kind === "not_found"));
  missing = false;
  const second = start(t);
  await t.waitFor(() => assert.ok(second.getView().kind === "failed"));
});
void test("a poll failure preserves the revision and automatically retries", async (t) => {
  let reads = 0;
  router(t, {
    [statePath]: () => {
      reads++;
      if (reads === 2) return new Response("", { status: 500 });
      return Response.json({ ...state, runningJob: reads === 1 ? job : null });
    },
    [`GET /api/revisions/${revision.id}/view`]: () => display(revision.id),
  });
  const session = start(t, { wait: () => Promise.resolve() });
  const problems: string[] = [];
  session.subscribe(() => {
    const view = openView(session);
    if (view.problem) {
      assert.equal(view.shown?.revision.id, revision.id);
      problems.push(view.problem);
    }
  });
  await t.waitFor(() => assert.ok(openView(session).activity.kind === "idle"));
  assert.deepEqual(problems, ["読み込みに失敗しました。"]);
  assert.equal(openView(session).problem, null);
});
void test("resend preserves the request and replaces the unsent instruction with exactly one server row", async (t) => {
  const posts: unknown[] = [];
  router(t, {
    [`POST ${messagesPath}`]: (init) => {
      assert.equal(typeof init.body, "string");
      posts.push(JSON.parse(init.body as string));
      if (posts.length === 1) return Promise.reject(new TypeError("offline"));
      return Response.json({ job }, { status: 202 });
    },
    [`GET ${messagesPath}`]: () =>
      Response.json({ messages: posts.length > 1 ? [row] : [], nextCursor: null }),
  });
  const session = start(t);
  await t.waitFor(() => assert.ok(session.getView().kind === "open"));
  const observed: string[] = [];
  session.subscribe(() => {
    const entry = openView(session).timeline[0];
    if (entry?.kind === "local") observed.push(entry.delivery.kind);
  });
  session.send(body());
  await t.waitFor(() => assert.ok(observed.includes("unsent")));
  assert.ok(!observed.includes("accepted"));
  const failed = openView(session).timeline[0];
  assert.ok(failed?.kind === "local");
  session.resend(failed.requestId);
  session.resend(failed.requestId);
  await t.waitFor(() => assert.ok(openView(session).timeline[0]?.kind === "server"));
  assert.deepEqual(posts, [
    { requestId: failed.requestId, body: row.body },
    { requestId: failed.requestId, body: row.body },
  ]);
  assert.equal(openView(session).timeline.length, 1);
});
void test("two instructions post sequentially in send order", async (t) => {
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  const posts: string[] = [];
  router(t, {
    [`POST ${messagesPath}`]: (init) => {
      assert.ok(typeof init.body === "string");
      posts.push(init.body);
      return posts.length === 1
        ? first
        : Response.json(
            { job: { ...job, messageId: crypto.randomUUID(), number: 2 } },
            { status: 202 },
          );
    },
  });
  const session = start(t);
  await t.waitFor(() => assert.ok(session.getView().kind === "open"));
  session.send(body("first"));
  session.send(body("second"));
  assert.equal(posts.length, 1);
  resolveFirst(Response.json({ job }, { status: 202 }));
  await t.waitFor(() => assert.ok(posts.length === 2));
  assert.match(posts[0] ?? "", /"body":"first"/);
  assert.match(posts[1] ?? "", /"body":"second"/);
});
void test("a stalled POST times out as unsent", async (t) => {
  router(t, {
    [`POST ${messagesPath}`]: (init) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  const session = start(t, { sendTimeoutMs: 5 });
  await t.waitFor(() => assert.ok(session.getView().kind === "open"));
  session.send(body());
  await t.waitFor(() => {
    const entry = openView(session).timeline[0];
    assert.ok(
      entry?.kind === "local" &&
        entry.delivery.kind === "unsent" &&
        entry.delivery.message.includes("接続"),
    );
  });
});
void test("a lost response wakes an idle screen and shows the server's running instruction", async (t) => {
  let accepted = false;
  router(t, {
    [`POST ${messagesPath}`]: () => {
      accepted = true;
      return Promise.reject(new TypeError("offline"));
    },
    [statePath]: () =>
      Response.json({ ...state, currentRevision: null, runningJob: accepted ? job : null }),
    [`GET ${messagesPath}`]: () =>
      Response.json({ messages: accepted ? [row] : [], nextCursor: null }),
  });
  const session = start(t);
  await t.waitFor(() => assert.ok(session.getView().kind === "open"));
  session.send(body());
  await t.waitFor(() => assert.ok(openView(session).timeline.length === 2));
  const [server, local] = openView(session).timeline;
  assert.ok(server?.kind === "server" && server.progress?.kind === "running");
  assert.ok(local?.kind === "local" && local.delivery.kind === "unsent");
});
void test("a row accepted between reads is labelled from the second state and continues polling", async (t) => {
  let reads = 0;
  router(t, {
    [statePath]: () =>
      Response.json({ ...state, currentRevision: null, runningJob: ++reads === 2 ? job : null }),
    [`GET ${messagesPath}`]: () => Response.json({ messages: [row], nextCursor: null }),
  });
  const session = start(t, { wait: () => Promise.resolve() });
  const labels: string[] = [];
  session.subscribe(() => {
    const entry = openView(session).timeline[0];
    if (entry?.kind === "server" && entry.progress) labels.push(entry.progress.kind);
  });
  await t.waitFor(() => assert.ok(labels.includes("settled")));
  assert.deepEqual(labels, ["running", "settled"]);
});

void test("stopping marks queued sends unsent and a restart can resend before the old POST rejects", async (t) => {
  let posts = 0;
  router(t, {
    [`POST ${messagesPath}`]: (init) => {
      posts++;
      if (posts === 1)
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      return Response.json({ job }, { status: 202 });
    },
  });
  const session = createProjectSession(parseProjectId(project.id));
  const stop = session.start();
  t.after(stop);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  session.send(body());
  session.send(body("次の指示"));
  stop();
  const entries = openView(session).timeline;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.kind === "local" && entry.delivery.kind === "unsent"));
  const first = entries[0];
  assert.ok(first?.kind === "local");
  t.after(session.start());
  session.resend(first.requestId);
  await t.waitFor(() => {
    const entry = openView(session).timeline[0];
    assert.ok(entry?.kind === "local" && entry.delivery.kind === "accepted");
  });
  assert.equal(posts, 2);
});

function floorPlanResponse(id: string, room: string) {
  const svg = `<svg class="floor-plan" data-storey-id="s1" viewBox="0 0 1 1"><text>${room}</text></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "x-revision-id": id } });
}
for (const failure of ["wrong revision", "transport"] as const) {
  void test(`a plan with ${failure} preserves the previous pair until both views arrive`, async (t) => {
    let current = revision;
    let recover = false;
    router(t, {
      [statePath]: () => Response.json({ ...state, currentRevision: current }),
      [`GET /api/revisions/${revision.id}/view`]: () => display(revision.id, "s1,s2"),
      [`GET /api/revisions/${revision.id}/floor-plan?storey=s1`]: () =>
        floorPlanResponse(revision.id, "A"),
      [`GET /api/revisions/${next.id}/view`]: () => display(next.id, "s1,s2", 4),
      [`GET /api/revisions/${next.id}/floor-plan?storey=s1`]: () => {
        if (recover) return floorPlanResponse(next.id, "B");
        if (failure === "transport") throw new TypeError("offline");
        return floorPlanResponse(revision.id, "A");
      },
    });
    const session = start(t);
    await t.waitFor(() => assert.equal(openView(session).shown?.revision.id, revision.id));
    const first = openView(session).shown;
    assert.ok(first?.plan.kind === "ready");
    assert.match(JSON.stringify(first.plan.plan.root), /"A"/);
    current = next;
    session.retry();
    await t.waitFor(() => assert.ok(openView(session).problem));
    assert.equal(openView(session).shown, first);
    recover = true;
    session.retry();
    await t.waitFor(() => assert.equal(openView(session).shown?.revision.id, next.id));
    const second = openView(session).shown;
    assert.ok(second?.plan.kind === "ready");
    assert.deepEqual(second.display, new Uint8Array([4]));
    assert.match(JSON.stringify(second.plan.plan.root), /"B"/);
    assert.equal(openView(session).problem, null);
  });
}
void test("a rejected plan keeps its model and is reused on the next poll", async (t) => {
  let polls = 0;
  const paths = router(t, {
    [statePath]: () => Response.json({ ...state, runningJob: ++polls === 1 ? job : null }),
    [`GET /api/revisions/${revision.id}/view`]: () => display(revision.id, "s1,s2"),
    [`GET /api/revisions/${revision.id}/floor-plan?storey=s1`]: () =>
      floorPlanResponse(revision.id, "<script/>"),
  });
  const session = start(t, { wait: () => Promise.resolve() });
  await t.waitFor(() => assert.equal(openView(session).activity.kind, "idle"));
  const view = openView(session);
  assert.deepEqual(view.shown, {
    revision,
    display: new Uint8Array([3]),
    plan: { kind: "rejected" },
  });
  assert.equal(view.problem, null);
  assert.equal(polls, 2);
  assert.equal(paths.filter((p) => p.includes("/revisions/")).length, 2);
});

function renameBody(init: RequestInit) {
  assert.ok(typeof init.body === "string");
  return renameRequestSchema.parse(JSON.parse(init.body));
}

function versionConflict() {
  return Response.json({ error: "version_conflict" }, { status: 409 });
}

void test("project rename updates the name and sends the saved version on the next rename", async (t) => {
  const requests: RenameRequest[] = [];
  router(t, {
    [`PATCH ${projectPath}`]: (init) => {
      const request = renameBody(init);
      requests.push(request);
      return Response.json({
        project: { ...project, name: request.name, version: request.version + 1 },
      });
    },
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  assert.equal(await session.rename("project", "北の家"), true);
  assert.deepEqual(openView(session).project, { ...project, name: "北の家", version: 2 });
  assert.equal(await session.rename("project", "南の家"), true);
  assert.deepEqual(
    requests.map(({ name, version }) => ({ name, version })),
    [
      { name: "北の家", version: 1 },
      { name: "南の家", version: 2 },
    ],
  );
  assert.notEqual(requests[0]?.requestId, requests[1]?.requestId);
});

for (const target of ["project", "pattern"] as const) {
  void test(`${target} rename re-reads a conflict and sends the latest version on retry`, async (t) => {
    const record = target === "project" ? project : pattern;
    const latest = { ...record, name: "別の名前", version: 4 };
    const requests: RenameRequest[] = [];
    const paths = router(t, {
      [`GET ${projectPath}`]: () =>
        Response.json({ project: target === "project" && requests.length ? latest : project }),
      [statePath]: () =>
        Response.json({
          ...state,
          currentRevision: null,
          pattern: target === "pattern" && requests.length ? latest : pattern,
        }),
      [`PATCH ${target === "project" ? projectPath : patternPath}`]: (init) => {
        const request = renameBody(init);
        requests.push(request);
        if (requests.length === 1) return versionConflict();
        return Response.json({ [target]: { ...latest, name: request.name, version: 5 } });
      },
    });
    const session = start(t);
    await t.waitFor(() => assert.equal(session.getView().kind, "open"));
    assert.equal(await session.rename(target, "自分の案"), false);
    assert.equal(paths.at(-1), target === "project" ? `GET ${projectPath}` : statePath);
    assert.deepEqual(openView(session)[target], latest);
    assert.deepEqual(openView(session).names[target], { kind: "conflict", latestName: "別の名前" });
    assert.equal(await session.rename(target, "自分の案"), true);
    assert.deepEqual(
      requests.map(({ version }) => version),
      [1, 4],
    );
    assert.deepEqual(openView(session).names[target], { kind: "idle" });
  });
}

void test("a conflict with the requested name already saved counts as success", async (t) => {
  let reads = 0;
  const saved = { ...project, name: "中庭", version: 3 };
  router(t, {
    [`GET ${projectPath}`]: () => Response.json({ project: ++reads === 1 ? project : saved }),
    [`PATCH ${projectPath}`]: versionConflict,
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  assert.equal(await session.rename("project", " 中庭 "), true);
  assert.deepEqual(openView(session).project, saved);
  assert.deepEqual(openView(session).names.project, { kind: "idle" });
});

void test("an older poll finishing after a rename preserves the newer pattern", async (t) => {
  let finishPoll!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finishPoll = resolve;
  });
  let reads = 0;
  const saved = { ...pattern, name: "平屋", version: 2 };
  router(t, {
    [statePath]: () =>
      ++reads === 1 ? Response.json({ ...state, currentRevision: null }) : pending,
    [`PATCH ${patternPath}`]: () => Response.json({ pattern: saved }),
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  session.retry();
  await t.waitFor(() => assert.equal(reads, 2));
  assert.equal(await session.rename("pattern", saved.name), true);
  finishPoll(Response.json({ ...state, currentRevision: null, runningJob: job }));
  await t.waitFor(() => assert.equal(openView(session).activity.kind, "working"));
  assert.deepEqual(openView(session).pattern, saved);
});

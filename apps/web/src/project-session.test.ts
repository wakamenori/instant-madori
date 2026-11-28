import { checkInstruction } from "./conversation.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  displayContentType,
  floorPlanStoreysHeader,
  renameRequestSchema,
  type RenameRequest,
  type PatternStateResponse,
  acceptInstructionRequestSchema,
  releaseQueueRequestSchema,
  stopJobRequestSchema,
  type AcceptInstructionRequest,
  type ReleaseQueueRequest,
  type StopJobRequest,
} from "@madori/contracts";
import { createProject } from "./api.ts";
import { parseRoute, formatRoute, parseProjectId, projectRoute } from "./route.ts";
import { createProjectSession, type ProjectView } from "./project-session.ts";

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
function openView(
  session: ReturnType<typeof createProjectSession>,
): Extract<ProjectView, { kind: "open" }> {
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
  await t.waitFor(() => assert.ok(openView(session).status.now.kind === "held"));
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
  await t.waitFor(() => assert.ok(openView(session).status.now.kind === "idle"));
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
  await t.waitFor(() => assert.equal(openView(session).status.now.kind, "idle"));
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
  await t.waitFor(() => assert.equal(openView(session).status.now.kind, "running"));
  assert.deepEqual(openView(session).pattern, saved);
});

const renameFailures: { case: string; patch: Handler; reread?: Handler; message: string }[] = [
  {
    case: "a server error",
    patch: () => Response.json({ error: "internal_error" }, { status: 500 }),
    message: "名前を変えられませんでした。",
  },
  {
    case: "a rejected name",
    patch: () => Response.json({ error: "invalid_request" }, { status: 400 }),
    message: "名前は1〜100文字で、見える文字を含めてください。",
  },
  {
    case: "a lost connection",
    patch: () => {
      throw new TypeError("Failed to fetch");
    },
    message: "通信できず名前を変えられませんでした。接続を確認してもう一度保存してください。",
  },
  {
    case: "a conflict whose re-read fails",
    patch: versionConflict,
    reread: () => Response.json({ error: "internal_error" }, { status: 500 }),
    message: "名前を変えられませんでした。",
  },
];

for (const failure of renameFailures) {
  void test(`a rename that meets ${failure.case} keeps the name and reports why`, async (t) => {
    let reads = 0;
    let fail = true;
    router(t, {
      [`GET ${projectPath}`]: (init) =>
        ++reads > 1 && failure.reread ? failure.reread(init) : Response.json({ project }),
      [`PATCH ${projectPath}`]: (init) =>
        fail
          ? failure.patch(init)
          : Response.json({ project: { ...project, name: "北の家", version: 2 } }),
    });
    const session = start(t);
    await t.waitFor(() => assert.equal(session.getView().kind, "open"));
    assert.equal(await session.rename("project", "北の家"), false);
    assert.deepEqual(openView(session).project, project);
    assert.deepEqual(openView(session).names.project, {
      kind: "failed",
      message: failure.message,
    });
    fail = false;
    assert.equal(await session.rename("project", "北の家"), true);
    assert.deepEqual(openView(session).names.project, { kind: "idle" });
  });
}

const withoutRevision = { ...state, currentRevision: null };
const queued = { jobId: crypto.randomUUID(), messageId: crypto.randomUUID(), number: 2 };
const question = {
  messageId: crypto.randomUUID(),
  number: 3,
  body: "和室は必要ですか？",
  choices: ["必要", "不要"],
};
const askingJob = { ...job, state: "awaiting_answer", question, answer: null } as const;
const answerJob = { jobId: crypto.randomUUID(), messageId: crypto.randomUUID(), number: 4 };
const askingState: PatternStateResponse = {
  ...withoutRevision,
  queueHold: { job: askingJob },
  queuedJobs: [queued],
  lastFinishedJob: askingJob,
};
const answeredState: PatternStateResponse = {
  ...askingState,
  queueHold: { job: { ...askingJob, answer: answerJob } },
  lastFinishedJob: { ...answerJob, state: "cancelled" },
};
const runningState = { ...withoutRevision, runningJob: job };
const heldState: PatternStateResponse = {
  ...withoutRevision,
  queueHold: { job: held },
  queuedJobs: [queued],
};
const stopPath = `POST /api/jobs/${job.jobId}/stop`;
const resumePath = `POST ${patternPath}/queue/resume`;
const cancelPath = `POST ${patternPath}/queue/cancel`;
const messagesPost = `POST ${messagesPath}`;

function statuses(session: ReturnType<typeof createProjectSession>) {
  const seen: string[] = [];
  session.subscribe(() => {
    const view = session.getView();
    if (view.kind === "open") seen.push(view.status.now.kind);
  });
  return seen;
}

function operationToken(
  session: ReturnType<typeof createProjectSession>,
  kind: "stop" | "resume" | "cancel",
) {
  const { now } = openView(session).status;
  if (kind === "stop") {
    assert.ok(now.kind === "running" || now.kind === "answering");
    assert.ok(now.stop);
    return now.stop;
  }
  assert.ok(now.kind === "asking" || now.kind === "held");
  assert.ok(now.release);
  return now.release[kind];
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { resolve, promise };
}

function waitingIntervals() {
  const waits: number[] = [];
  return {
    waits,
    wait: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

function newerRows() {
  return Array.from({ length: 50 }, (_, index) => ({
    ...row,
    id: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    number: 54 - index,
  }));
}

function ask(session: ReturnType<typeof createProjectSession>) {
  const { now } = openView(session).status;
  assert.equal(now.kind, "asking");
  session.answer(now.question, body("必要"));
}

void test("an answer job inside a hold is polled through completion, then polling sleeps", async (t) => {
  const states = [
    { ...answeredState, queuedJobs: [answerJob, queued], lastFinishedJob: askingJob },
    { ...answeredState, runningJob: answerJob, lastFinishedJob: askingJob },
    answeredState,
  ];
  const paths = router(t, { [statePath]: () => Response.json(states.shift() ?? answeredState) });
  const { waits, wait } = waitingIntervals();
  const session = start(t, { wait });
  const seen = statuses(session);
  await t.waitFor(() => assert.equal(openView(session).status.now.kind, "held"));
  await nextTurn();
  assert.deepEqual(seen, ["answering", "answering", "held"]);
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(paths.filter((path) => path === statePath).length, 3);
});

void test("reopening restores an open question from state even if the latest conversation page omits it", async (t) => {
  const messages = newerRows();
  const current = {
    ...askingState,
    queuedJobs: messages
      .map((entry) => ({
        jobId: entry.jobId,
        messageId: entry.id,
        number: entry.number,
      }))
      .reverse(),
  };
  const { waits, wait } = waitingIntervals();
  router(t, {
    [statePath]: () => Response.json(current),
    [`GET ${messagesPath}`]: () => Response.json({ messages, nextCursor: "older" }),
  });
  const session = start(t, { wait });
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  const view = openView(session);
  const { now, receipt } = view.status;
  assert.equal(now.kind, "asking");
  assert.equal(now.held, 50);
  assert.deepEqual(now.question, {
    messageId: question.messageId,
    body: question.body,
    choices: question.choices,
  });
  assert.equal(receipt, null);
  assert.equal(view.timeline.length, 50);
  assert.ok(
    view.timeline.every((entry) => entry.kind === "server" && entry.message.kind === "instruction"),
  );
  assert.deepEqual(waits, []);
});

for (const accepted of [true, false]) {
  void test(
    accepted
      ? "an accepted answer absent from the latest page no longer blocks release after refresh"
      : "a failed answer POST blocks release until the refreshed state is published",
    async (t) => {
      const messages = newerRows();
      const response = deferredResponse();
      const refreshed = deferredResponse();
      let posting = false;
      const { waits, wait } = waitingIntervals();
      const paths = router(t, {
        [statePath]: () => (posting ? refreshed.promise : Response.json(askingState)),
        [`GET ${messagesPath}`]: () => Response.json({ messages, nextCursor: "older" }),
        [messagesPost]: () => {
          posting = true;
          return response.promise;
        },
      });
      const session = start(t, { wait });
      await t.waitFor(() => assert.equal(session.getView().kind, "open"));
      assert.ok(operationToken(session, "resume"));
      ask(session);
      let view = openView(session);
      assert.equal(view.inputInFlight, true);
      assert.equal(view.status.now.kind, "asking");
      assert.equal(view.status.now.release, null);
      response.resolve(
        accepted
          ? Response.json({ job: answerJob }, { status: 202 })
          : Response.json({ error: "internal_error" }, { status: 500 }),
      );
      await t.waitFor(() => {
        const entry = openView(session).timeline.find((row) => row.kind === "local");
        assert.ok(entry?.kind === "local");
        assert.equal(entry.delivery.kind, accepted ? "accepted" : "unsent");
      });
      view = openView(session);
      assert.equal(view.inputInFlight, true);
      assert.equal(view.status.now.kind, "asking");
      assert.equal(view.status.now.release, null);
      const after = accepted ? answeredState : askingState;
      refreshed.resolve(Response.json(after));
      await t.waitFor(() => assert.equal(openView(session).inputInFlight, false));
      assert.equal(openView(session).status.now.kind, accepted ? "held" : "asking");
      assert.ok(operationToken(session, "resume"));
      assert.ok(
        openView(session).timeline.every(
          (entry) => entry.kind === "local" || entry.message.id !== answerJob.messageId,
        ),
      );
      assert.ok(paths.includes(messagesPost));
      assert.deepEqual(waits, []);
    },
  );
}

void test("a non-overlapping latest page replaces previously loaded rows", async (t) => {
  const latestPage = newerRows();
  let latest = false;
  router(t, {
    [`GET ${messagesPath}`]: () =>
      Response.json(
        latest
          ? { messages: latestPage, nextCursor: "older" }
          : { messages: [row], nextCursor: null },
      ),
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(openView(session).timeline.length, 1));
  latest = true;
  session.retry();
  await t.waitFor(() => assert.equal(openView(session).timeline.length, 50));
  assert.deepEqual(
    openView(session).timeline.map((entry) => entry.key),
    latestPage.map(({ id }) => `message:${id}`).reverse(),
  );
});

void test("stop posts once, holds the action pending through refresh, and confirms the stop with another job running", async (t) => {
  const response = deferredResponse();
  const refreshed = deferredResponse();
  const requests: StopJobRequest[] = [];
  router(t, {
    [statePath]: () => (requests.length === 0 ? Response.json(runningState) : refreshed.promise),
    [stopPath]: (init) => {
      assert.ok(typeof init.body === "string");
      requests.push(stopJobRequestSchema.parse(JSON.parse(init.body)));
      return response.promise;
    },
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  const token = operationToken(session, "stop");
  session.act(token);
  session.act(token);
  assert.equal(openView(session).status.pending, "stop");
  assert.equal(requests.length, 1);
  response.resolve(Response.json({ outcome: "stopped", job: { ...job, state: "cancelled" } }));
  await nextTurn();
  session.act(token);
  assert.equal(openView(session).status.pending, "stop");
  assert.equal(requests.length, 1);
  refreshed.resolve(Response.json({ ...withoutRevision, runningJob: queued }));
  await t.waitFor(() => assert.deepEqual(openView(session).status.receipt, { kind: "stopped" }));
  assert.equal(openView(session).status.pending, null);
  const nextToken = operationToken(session, "stop");
  assert.ok(nextToken.kind === "stop");
  assert.equal(nextToken.jobId, queued.jobId);
});

void test("when the job finishes before stop, the receipt and new revision arrive together", async (t) => {
  let finished = false;
  const completed = { ...job, state: "completed", revision: next } as const;
  router(t, {
    [statePath]: () =>
      Response.json(
        finished
          ? { ...withoutRevision, currentRevision: next, lastFinishedJob: completed }
          : runningState,
      ),
    [stopPath]: () => {
      finished = true;
      return Response.json({ outcome: "already_finished", job: completed });
    },
    [`GET /api/revisions/${next.id}/view`]: () => display(next.id),
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  session.act(operationToken(session, "stop"));
  await t.waitFor(() =>
    assert.deepEqual(openView(session).status.receipt, {
      kind: "finished_first",
      ending: "completed",
      revision: next,
    }),
  );
  assert.deepEqual(openView(session).shown?.revision, next);
});

for (const result of ["state", "an error"] as const) {
  void test(`an earlier state read that returns ${result} after the stop response is discarded`, async (t) => {
    const stale = deferredResponse();
    const response = deferredResponse();
    let reads = 0;
    const cancelled = { ...job, state: "cancelled" } as const;
    router(t, {
      [statePath]: () => {
        reads++;
        if (reads === 1) return Response.json(runningState);
        if (reads === 2) return stale.promise;
        return Response.json({ ...withoutRevision, lastFinishedJob: cancelled });
      },
      [stopPath]: () => response.promise,
    });
    const session = start(t);
    const seen = statuses(session);
    await t.waitFor(() => assert.equal(session.getView().kind, "open"));
    session.retry();
    await t.waitFor(() => assert.equal(reads, 2));
    session.act(operationToken(session, "stop"));
    response.resolve(Response.json({ outcome: "stopped", job: cancelled }));
    await nextTurn();
    stale.resolve(
      result === "state"
        ? Response.json({ ...runningState, queuedJobs: [queued], runningJob: null })
        : Response.json({ error: "internal_error" }, { status: 500 }),
    );
    await t.waitFor(() => assert.deepEqual(openView(session).status.receipt, { kind: "stopped" }));
    assert.deepEqual(seen, ["running", "running", "idle"]);
    assert.equal(reads, 3);
  });
}

function releaseBody(init: RequestInit) {
  assert.ok(typeof init.body === "string");
  return releaseQueueRequestSchema.parse(JSON.parse(init.body));
}

void test("a conflicting resume refreshes the hold and exposes the new token", async (t) => {
  const requests: ReleaseQueueRequest[] = [];
  router(t, {
    [statePath]: () =>
      Response.json(
        requests.length === 0
          ? heldState
          : {
              ...askingState,
              queueHold: { job: { ...askingJob, jobId: answerJob.jobId } },
            },
      ),
    [resumePath]: (init) => {
      requests.push(releaseBody(init));
      return versionConflict();
    },
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  session.act(operationToken(session, "resume"));
  await t.waitFor(() => assert.deepEqual(openView(session).status.receipt, { kind: "conflict" }));
  assert.deepEqual(
    requests.map(({ heldBy }) => heldBy),
    [held.jobId],
  );
  const action = operationToken(session, "resume");
  assert.ok(action.kind === "resume");
  assert.equal(action.heldBy, answerJob.jobId);
});

for (const how of ["resume", "cancel"] as const) {
  void test(
    how === "resume"
      ? "successful resume keeps polling through starting and running to idle"
      : "cancelling closes the question and the session sleeps",
    async (t) => {
      const requests: ReleaseQueueRequest[] = [];
      const resumed = [
        { ...withoutRevision, queuedJobs: [queued] },
        { ...withoutRevision, runningJob: queued },
      ];
      const cancelled = { ...queued, state: "cancelled" };
      router(t, {
        [statePath]: () =>
          Response.json(
            requests.length === 0
              ? askingState
              : how === "resume"
                ? (resumed.shift() ?? withoutRevision)
                : withoutRevision,
          ),
        [how === "resume" ? resumePath : cancelPath]: (init) => {
          requests.push(releaseBody(init));
          return Response.json({ jobs: [how === "resume" ? queued : cancelled] });
        },
      });
      const { waits, wait } = waitingIntervals();
      const session = start(t, { wait });
      const seen = statuses(session);
      const receipts: unknown[] = [];
      session.subscribe(() => {
        const view = session.getView();
        if (view.kind === "open" && view.status.receipt) receipts.push(view.status.receipt);
      });
      await t.waitFor(() => assert.equal(session.getView().kind, "open"));
      session.act(operationToken(session, how));
      await t.waitFor(() => assert.equal(openView(session).status.now.kind, "idle"));
      assert.deepEqual(
        requests.map(({ heldBy }) => heldBy),
        [askingJob.jobId],
      );
      assert.deepEqual(receipts, [{ kind: "released", how, count: 1, closedQuestion: true }]);
      assert.deepEqual(
        seen,
        how === "resume"
          ? ["asking", "asking", "starting", "running", "idle"]
          : ["asking", "asking", "idle"],
      );
      assert.deepEqual(waits, how === "resume" ? [1000, 1000] : []);
      if (how === "resume") assert.equal(openView(session).status.receipt, null);
    },
  );
}

void test("an uncertain resume stays retryable after another instruction, and the retry replays the same request", async (t) => {
  const requests: ReleaseQueueRequest[] = [];
  let instructionAccepted = false;
  router(t, {
    [statePath]: () =>
      Response.json(
        requests.length > 1
          ? withoutRevision
          : {
              ...heldState,
              queuedJobs: instructionAccepted ? [queued, answerJob] : [queued],
            },
      ),
    [messagesPost]: () => {
      instructionAccepted = true;
      return Response.json({ job: answerJob }, { status: 202 });
    },
    [resumePath]: (init) => {
      requests.push(releaseBody(init));
      return requests.length === 1
        ? Response.json({ error: "internal_error" }, { status: 500 })
        : Response.json({ jobs: [queued, answerJob] });
    },
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  session.act(operationToken(session, "resume"));
  await t.waitFor(() => assert.equal(openView(session).status.canRetry, true));
  assert.deepEqual(openView(session).status.receipt, {
    kind: "failed",
    action: "resume",
    uncertain: true,
  });
  session.send(body());
  await t.waitFor(() => {
    const { status } = openView(session);
    assert.equal(status.now.kind, "held");
    assert.equal(status.now.held, 2);
    assert.equal(status.canRetry, true);
  });
  session.retryOperation();
  await t.waitFor(() =>
    assert.deepEqual(openView(session).status.receipt, {
      kind: "released",
      how: "resume",
      closedQuestion: false,
      count: 2,
    }),
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
});

void test("answer retries carry the same question and rejected answers can become new instructions", async (t) => {
  const requests: AcceptInstructionRequest[] = [];
  const routerResponse = deferredResponse();
  router(t, {
    [statePath]: () => Response.json(askingState),
    [messagesPost]: (init) => {
      assert.ok(typeof init.body === "string");
      const request: AcceptInstructionRequest = acceptInstructionRequestSchema.parse(
        JSON.parse(init.body),
      );
      requests.push(request);
      if (requests.length === 1) throw new TypeError("offline");
      if (requests.length === 2) return versionConflict();
      return routerResponse.promise;
    },
  });
  const session = start(t);
  await t.waitFor(() => assert.equal(session.getView().kind, "open"));
  ask(session);
  function answerRow() {
    const entry = openView(session).timeline.find((row) => row.kind === "local");
    assert.ok(entry?.kind === "local");
    return entry;
  }
  await t.waitFor(() => assert.equal(answerRow().delivery.kind, "unsent"));
  const { requestId } = answerRow();
  assert.equal(answerRow().questionId, question.messageId);
  session.resend(requestId);
  await t.waitFor(() => assert.equal(answerRow().delivery.kind, "rejected"));
  assert.equal(answerRow().questionId, question.messageId);
  session.resend(requestId);
  assert.deepEqual(requests[0], {
    requestId,
    questionId: question.messageId,
    body: "必要",
    attachmentIds: [],
  });
  assert.deepEqual(requests[1], requests[0]);
  const newInstruction = answerRow();
  assert.notEqual(newInstruction.requestId, requestId);
  assert.equal(newInstruction.questionId, null);
  assert.deepEqual(requests[2], {
    requestId: newInstruction.requestId,
    body: "必要",
    attachmentIds: [],
  });
  routerResponse.resolve(Response.json({ job: queued }, { status: 202 }));
});

for (const reopen of [heldState, askingState, { ...answeredState, runningJob: answerJob }]) {
  void test(`reopening reproduces the ${reopen.runningJob ? "answering" : reopen.queueHold?.job.state} status without an operation receipt`, async (t) => {
    router(t, { [statePath]: () => Response.json(reopen) });
    const first = start(t);
    const second = start(t);
    await t.waitFor(() => {
      assert.equal(first.getView().kind, "open");
      assert.equal(second.getView().kind, "open");
    });
    assert.deepEqual(openView(second).status, {
      now: openView(first).status.now,
      pending: null,
      receipt: null,
      canRetry: false,
    });
    const now = openView(second).status.now;
    assert.equal(
      now.kind,
      reopen.runningJob ? "answering" : reopen === askingState ? "asking" : "held",
    );
  });
}

const imageFile = new Blob(["image to decode"], { type: "image/png" });
const preparedImage = new Blob(["prepared jpeg"], { type: "image/jpeg" });
const asset = {
  id: crypto.randomUUID(),
  mediaType: "image/jpeg",
  bytes: preparedImage.size,
  width: 2,
  height: 1,
  sha256: "a".repeat(64),
  createdAt,
};
const assetRequestId = crypto.randomUUID();
const uploadPath = `POST /api/assets?requestId=${assetRequestId}`;
function uploadResponse(id = asset.id) {
  return Response.json({ asset: { ...asset, id } }, { status: 201 });
}

void test("an instruction waits for its attachment, resends the same IDs, and can reopen the saved image", async (t) => {
  const { promise: upload, resolve: finishUpload } = deferredResponse();
  const posts: unknown[] = [];
  const paths = router(t, {
    [uploadPath]: (init) => {
      assert.equal(init.body, preparedImage);
      assert.equal(new Headers(init.headers).get("content-type"), "image/jpeg");
      return upload;
    },
    [`POST ${messagesPath}`]: (init) => {
      assert.ok(typeof init.body === "string");
      posts.push(JSON.parse(init.body));
      if (posts.length === 1) return Promise.reject(new TypeError("offline"));
      return Response.json({ job }, { status: 202 });
    },
    [`GET ${messagesPath}`]: () =>
      Response.json({
        messages: posts.length > 1 ? [{ ...row, attachmentIds: [asset.id] }] : [],
        nextCursor: null,
      }),
    [`GET /api/assets/${asset.id}`]: () => new Response(preparedImage),
  });
  const messageRequestId = crypto.randomUUID();
  const ids = [assetRequestId, messageRequestId];
  const session = start(t, {
    newRequestId: () => {
      const id = ids.shift();
      assert.ok(id);
      return id;
    },
    prepareImage: (file) => {
      assert.equal(file, imageFile);
      return Promise.resolve({ blob: preparedImage });
    },
  });
  await t.waitFor(() => openView(session));
  session.attach([imageFile]);
  assert.equal(session.send(body()), false);
  await t.waitFor(() => assert.equal(openView(session).drafts[0]?.state.kind, "uploading"));
  assert.equal(session.send(body()), false);
  assert.deepEqual(posts, []);
  finishUpload(uploadResponse());
  await t.waitFor(() => assert.equal(openView(session).drafts[0]?.state.kind, "ready"));
  assert.equal(session.send(body()), true);
  assert.deepEqual(openView(session).drafts, []);
  assert.deepEqual(
    paths.filter((path) => path.startsWith("POST")),
    [uploadPath, `POST ${messagesPath}`],
  );
  await t.waitFor(() => {
    const entry = openView(session).timeline[0];
    assert.ok(entry?.kind === "local" && entry.delivery.kind === "unsent");
    assert.deepEqual(entry.attachmentIds, [asset.id]);
  });
  assert.equal(session.assetImages.get(asset.id)?.kind, "ready");
  session.resend(messageRequestId);
  await t.waitFor(() => assert.equal(openView(session).timeline[0]?.kind, "server"));
  const request = { requestId: messageRequestId, body: row.body, attachmentIds: [asset.id] };
  assert.deepEqual(posts, [request, request]);
  assert.ok(!paths.includes(`GET /api/assets/${asset.id}`));

  const reopened = start(t);
  await t.waitFor(() => {
    const entry = openView(reopened).timeline[0];
    assert.ok(entry?.kind === "server");
    assert.deepEqual(entry.message.attachmentIds, [asset.id]);
  });
  await reopened.assetImages.load(asset.id);
  assert.equal(reopened.assetImages.get(asset.id)?.kind, "ready");
  assert.equal(paths.filter((path) => path === `GET /api/assets/${asset.id}`).length, 1);
});

void test("oversized prepared images are refused before upload and leave a text-only instruction", async (t) => {
  const posts: unknown[] = [];
  const paths = router(t, {
    [`POST ${messagesPath}`]: (init) => {
      assert.ok(typeof init.body === "string");
      posts.push(JSON.parse(init.body));
      return Response.json({ job }, { status: 202 });
    },
  });
  const oversized = new Blob([new Uint8Array(7_499_998)], { type: "image/jpeg" });
  const session = start(t, {
    newRequestId: () => assetRequestId,
    prepareImage: () => Promise.resolve({ blob: oversized }),
  });
  await t.waitFor(() => openView(session));
  session.attach([imageFile]);
  await t.waitFor(() =>
    assert.equal(
      openView(session).attachNotice,
      "画像を縮小しても大きすぎるため添えられません（7.5MBまで）。",
    ),
  );
  assert.deepEqual(openView(session).drafts, []);
  assert.equal(session.send(body()), true);
  assert.deepEqual(posts, [{ requestId: assetRequestId, body: row.body }]);
  assert.equal(openView(session).attachNotice, null);
  assert.ok(!paths.some((path) => path.startsWith("POST /api/assets")));
});

void test("two batches accept only the first three images and send their IDs in selection order", async (t) => {
  const uploadIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  const assetIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  const messageId = crypto.randomUUID();
  const ids = [...uploadIds, messageId];
  const first = deferredResponse();
  const posts: unknown[] = [];
  const paths = router(t, {
    ...Object.fromEntries(
      uploadIds.map((id, index) => [
        `POST /api/assets?requestId=${id}`,
        () => (index === 0 ? first.promise : uploadResponse(assetIds[index])),
      ]),
    ),
    [`POST ${messagesPath}`]: (init) => {
      assert.ok(typeof init.body === "string");
      posts.push(JSON.parse(init.body));
      return Response.json({ job }, { status: 202 });
    },
  });
  const session = start(t, {
    newRequestId: () => {
      const id = ids.shift();
      assert.ok(id);
      return id;
    },
    prepareImage: () => Promise.resolve({ blob: preparedImage }),
  });
  await t.waitFor(() => openView(session));
  session.attach([imageFile, imageFile]);
  session.attach([imageFile, imageFile]);
  await t.waitFor(() => {
    const view = openView(session);
    assert.equal(view.attachNotice, "画像は一つの指示に3枚まで添えられます。");
    assert.deepEqual(
      view.drafts.map(({ state }) => state.kind),
      ["uploading", "ready", "ready"],
    );
  });
  first.resolve(uploadResponse(assetIds[0]));
  await t.waitFor(() =>
    assert.ok(openView(session).drafts.every(({ state }) => state.kind === "ready")),
  );
  assert.equal(session.send(body()), true);
  assert.deepEqual(
    paths.filter((path) => path.startsWith("POST /api/assets")),
    uploadIds.map((id) => `POST /api/assets?requestId=${id}`),
  );
  assert.deepEqual(posts, [{ requestId: messageId, body: row.body, attachmentIds: assetIds }]);
});

void test("retry keeps the upload request ID and detaching aborts the request", async (t) => {
  let attempts = 0;
  let uploadSignal: AbortSignal | null | undefined;
  const pending = deferredResponse();
  const paths = router(t, {
    [uploadPath]: (init) => {
      attempts++;
      assert.equal(init.body, preparedImage);
      if (attempts === 1) return Promise.reject(new TypeError("offline"));
      uploadSignal = init.signal;
      return pending.promise;
    },
  });
  const session = start(t, {
    newRequestId: () => assetRequestId,
    prepareImage: () => Promise.resolve({ blob: preparedImage }),
  });
  await t.waitFor(() => openView(session));
  session.attach([imageFile]);
  await t.waitFor(() =>
    assert.deepEqual(openView(session).drafts[0]?.state, {
      kind: "failed",
      retryable: true,
      message: "通信できず画像を登録できませんでした。再試行してください。",
    }),
  );
  const draft = openView(session).drafts[0];
  assert.ok(draft);
  assert.equal(session.send(body()), false);
  session.retryAttachment(draft.key);
  session.detach(draft.key);
  assert.equal(uploadSignal?.aborted, true);
  assert.deepEqual(openView(session).drafts, []);
  pending.resolve(uploadResponse());
  await nextTurn();
  assert.deepEqual(openView(session).drafts, []);
  assert.equal(session.assetImages.get(asset.id), undefined);
  assert.deepEqual(
    paths.filter((path) => path.startsWith("POST")),
    [uploadPath, uploadPath],
  );
});

void test("stopping uploads marks drafts retryable and a restarted session can finish registration", async (t) => {
  const pending = deferredResponse();
  const signals: AbortSignal[] = [];
  router(t, {
    [uploadPath]: (init) => {
      assert.ok(init.signal);
      signals.push(init.signal);
      return signals.length === 1 ? pending.promise : uploadResponse();
    },
  });
  const session = createProjectSession(parseProjectId(project.id), {
    newRequestId: () => assetRequestId,
    prepareImage: () => Promise.resolve({ blob: preparedImage }),
  });
  const stop = session.start();
  t.after(stop);
  await t.waitFor(() => openView(session));
  session.attach([imageFile]);
  await t.waitFor(() => assert.equal(openView(session).drafts[0]?.state.kind, "uploading"));
  const before = openView(session).drafts[0];
  assert.ok(before);
  stop();
  assert.equal(signals[0]?.aborted, true);
  const interrupted = openView(session).drafts[0]?.state;
  assert.ok(interrupted?.kind === "failed" && interrupted.retryable);

  t.after(session.start());
  session.retryAttachment(before.key);
  pending.resolve(uploadResponse());
  await t.waitFor(() => assert.equal(openView(session).drafts[0]?.state.kind, "ready"));
  assert.equal(signals.length, 2);
  assert.notEqual(openView(session).drafts[0]?.previewUrl, before.previewUrl);
});

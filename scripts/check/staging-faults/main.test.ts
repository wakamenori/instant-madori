import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  displayContentType,
  type AcceptedJob,
  type FinishedJob,
  type Revision,
  type CancelledJob,
} from "../../../packages/contracts/src/index.ts";
import type { Committed } from "./history.ts";
import { faultTarget, runFaultJourney } from "./main.ts";

type Fault =
  | "clean"
  | "aborted run"
  | "late commit"
  | "changed display"
  | "old version"
  | "advance failed"
  | "missing hold"
  | "parallel deploy"
  | "late adoption"
  | "missed window";
function staging(fault: Fault) {
  let now = Date.UTC(2026, 10, 20);
  const start = now;
  const iso = (at: number) => new Date(at).toISOString();
  const project = {
    id: randomUUID(),
    name: "test",
    version: 1,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  const pattern = { ...project, id: randomUUID(), projectId: project.id };
  const revisions: Revision[] = [];
  const displays = new Map<string, string>();
  function commit() {
    const r = {
      id: randomUUID(),
      patternId: pattern.id,
      name: "案",
      number: revisions.length + 1,
      baseRevisionId: revisions.at(-1)?.id ?? null,
      createdAt: iso(now),
    };
    revisions.push(r);
    displays.set(r.id, "sample");
    return r;
  }
  const first = commit();
  commit();
  let number = 0;
  let running: AcceptedJob | null = null;
  let hold: CancelledJob | null = null;
  let last: FinishedJob | null = null;
  const queued: AcceptedJob[] = [];
  if (fault === "aborted run") {
    hold = { jobId: randomUUID(), messageId: randomUUID(), number: ++number, state: "cancelled" };
    queued.push({ jobId: randomUUID(), messageId: randomUUID(), number: ++number });
  }
  const finished = new Map<string, FinishedJob>();
  const accepted = new Map<string, AcceptedJob>();
  const posts: string[] = [];
  const evidence = new Map<string, string>();
  const records = new Map<string, { key: string; bytes: string; status: number }>();
  const lines: {
    timestamp: number;
    source: object;
    $workers: { scriptVersion: { id: string } };
    patternId: string | null;
    traceId: string;
  }[] = [];
  const deployment = start + 300_000;
  const version = () => (now >= deployment + 30_000 ? "new" : "old");
  function log(
    job: AcceptedJob,
    event: string,
    outcome: string,
    fields: object = {},
    v = version(),
  ) {
    lines.push({
      timestamp: now,
      source: { jobId: job.jobId, event, outcome, ...fields },
      $workers: { scriptVersion: { id: v } },
      patternId: event.startsWith("container.") ? null : pattern.id,
      traceId: job.jobId,
    });
  }
  const scheduled: { at: number; act: () => void }[] = [];
  function later(ms: number, act: () => void) {
    scheduled.push({ at: now + ms, act });
  }
  function sleep(ms: number) {
    const end = now + ms;
    for (;;) {
      scheduled.sort((a, b) => a.at - b.at);
      const next = scheduled[0];
      if (!next || next.at > end) break;
      scheduled.shift();
      now = next.at;
      next.act();
    }
    now = end;
    return Promise.resolve();
  }
  function claim(job: AcceptedJob) {
    running = job;
    const claimed = version();
    log(job, "pattern.advanced", "claimed");
    if (!(fault === "missing hold" && job.number === 2))
      log(job, "job.step", "hold", { step: "check test hold before render" });
    later(60_000, () => {
      if (running?.jobId === job.jobId)
        log(
          job,
          "pattern.advanced",
          "running",
          { instanceStatus: "sleeping" },
          fault === "old version" ? claimed : version(),
        );
    });
    later(180_000, () => {
      if (running?.jobId !== job.jobId) {
        log(job, "job.finished", "cancelled");
        if (fault === "late commit" && job.number === 2) commit();
        return;
      }
      log(job, "container.ready", "ready");
      later(5000, () => {
        const revision = commit();
        last = { ...job, state: "completed", revision };
        finished.set(job.jobId, last);
        running = null;
        log(job, "job.step", "saved", { step: "render snapshot" });
        log(job, "job.finished", "committed", { revisionId: revision.id }, claimed);
        if (fault === "changed display") displays.set(first.id, "different bytes");
        if (fault === "advance failed") log(job, "pattern.advance_failed", "failed");
      });
    });
  }
  function mutate(path: string, body: { heldBy?: string | undefined }) {
    if (path === `/api/projects/${project.id}/patterns`)
      return Response.json({ pattern }, { status: 201 });
    if (path === `/api/patterns/${pattern.id}/messages`) {
      const job = { jobId: randomUUID(), messageId: randomUUID(), number: ++number };
      accepted.set(job.jobId, job);
      if (running || hold) queued.push(job);
      else claim(job);
      return Response.json({ job }, { status: 202 });
    }
    if (path.endsWith("/stop")) {
      const id = path.split("/").at(-2);
      assert(id);
      const previous = finished.get(id);
      if (previous) return Response.json({ outcome: "already_finished", job: previous });
      const job = accepted.get(id);
      assert(job);
      last = { ...job, state: "cancelled" };
      finished.set(id, last);
      if (running?.jobId === id) running = null;
      else
        queued.splice(
          queued.findIndex((q) => q.jobId === id),
          1,
        );
      if (queued.length) hold = last;
      return Response.json({ outcome: "stopped", job: last });
    }
    assert.equal(body.heldBy, hold?.jobId);
    hold = null;
    const jobs = queued.splice(0);
    if (path.endsWith("/cancel"))
      return Response.json({ jobs: jobs.map((job) => ({ ...job, state: "cancelled" })) });
    assert(path.endsWith("/resume"));
    const [job] = jobs;
    assert(job);
    claim(job);
    return Response.json({ jobs });
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const path = url.pathname;
    if (url.hostname === "api.cloudflare.com") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake");
      assert(typeof init?.body === "string");
      const query = z
        .object({
          parameters: z.object({
            filters: z.array(z.object({ key: z.string(), value: z.string() })),
          }),
          timeframe: z.object({ from: z.number(), to: z.number() }),
        })
        .parse(JSON.parse(init.body));
      const [service, filter] = query.parameters.filters;
      assert.equal(service?.value, "service");
      assert(filter?.key === "traceId" || filter?.key === "patternId");
      const key = filter.key;
      const events = lines.filter(
        (l) =>
          l[key] === filter.value &&
          l.timestamp + 90_000 <= now &&
          l.timestamp >= query.timeframe.from &&
          l.timestamp <= query.timeframe.to,
      );
      return Response.json({ success: true, result: { events: { events: events.reverse() } } });
    }
    assert.equal(url.origin, "https://staging.test");
    assert.equal(init?.redirect, "manual");
    assert(init?.signal);
    assert.equal(new Headers(init.headers).get("CF-Access-Client-Id"), "verifier");
    if (init.method === "POST") {
      posts.push(path);
      assert.equal(new Headers(init.headers).get("origin"), url.origin);
      assert(typeof init.body === "string");
      const body = z
        .object({ requestId: z.uuid(), heldBy: z.uuid().optional() })
        .parse(JSON.parse(init.body));
      const key = path + init.body;
      const prior = records.get(body.requestId);
      if (prior)
        return key === prior.key
          ? new Response(prior.bytes, { status: prior.status })
          : Response.json({ error: "request_id_reused" }, { status: 422 });
      const response = mutate(path, body);
      records.set(body.requestId, {
        key,
        bytes: await response.clone().text(),
        status: response.status,
      });
      return response;
    }
    if (path === "/api/me")
      return Response.json({ user: { id: project.id, email: "verifier@staging.invalid" } });
    if (path === "/api/projects") return Response.json({ projects: [project], nextCursor: null });
    if (path.endsWith("/state"))
      return Response.json({
        pattern,
        currentRevision: revisions.at(-1),
        runningJob: running,
        lastFinishedJob: last,
        queuedJobs: queued,
        queueHold: hold ? { job: hold } : null,
      });
    if (path.endsWith("/revisions")) {
      const offset = Number(url.searchParams.get("cursor"));
      return Response.json({
        revisions: revisions
          .slice()
          .reverse()
          .slice(offset, offset + 1),
        nextCursor: offset + 1 < revisions.length ? String(offset + 1) : null,
      });
    }
    const id = path.split("/").at(-2);
    assert(id && displays.has(id));
    return new Response(displays.get(id), {
      headers: { "content-type": displayContentType, "x-revision-id": id },
    });
  };
  function gh(args: readonly string[]) {
    if (args[0] === "api") return fault === "parallel deploy" ? "47\n48" : "47";
    assert.deepEqual(args.slice(0, 4), ["run", "view", "47", "--json"]);
    const stepStart =
      fault === "late adoption"
        ? start - 60_000
        : fault === "missed window"
          ? start + 10_000
          : deployment;
    const end = stepStart + 30_000;
    return JSON.stringify({
      databaseId: 47,
      event: "workflow_dispatch",
      headBranch: "main",
      url: "https://github.test/run/47",
      status: now >= start + 750_000 ? "completed" : "in_progress",
      conclusion: now >= start + 750_000 ? "success" : "",
      jobs: [
        {
          steps: [
            {
              name: "Migrate and deploy",
              status: now < stepStart ? "pending" : now < end ? "in_progress" : "completed",
              startedAt: iso(stepStart),
              completedAt: iso(end),
            },
          ],
        },
      ],
    });
  }
  const target = faultTarget(
    JSON.stringify({
      env: {
        staging: {
          name: "service",
          vars: {
            ENVIRONMENT: "staging",
            APP_ORIGINS: "https://staging.test",
            JOB_TEST_HOLD: "before_render:180",
          },
        },
      },
    }),
  );
  const run = () =>
    runFaultJourney(
      {
        target,
        service: target.service,
        deployRun: "47",
        token: { clientId: "verifier", clientSecret: "fake" },
        cloudflare: { CLOUDFLARE_API_TOKEN: "fake", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) },
      },
      {
        fetcher,
        gh: (args) => Promise.resolve(gh(args)),
        clock: { now: () => now, sleep },
        evidence: (file, data) => {
          evidence.set(file, data);
          return Promise.resolve();
        },
      },
    );
  return { run, first, posts, revisions, evidence };
}
void test("history grows from two revisions to five across replay, stop, deploy and resume", async () => {
  const fake = staging("clean");
  const result = await fake.run();
  assert.equal(result.kind, "pass");
  if (result.kind === "pass")
    assert.deepEqual(
      [result.restart.from, result.restart.to, result.restart.workflowVersion],
      ["old", "new", "old"],
    );
  assert.equal(fake.revisions.length, 5);
  const revision = z.object({
    id: z.uuid(),
    number: z.int(),
    name: z.string(),
    baseRevisionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    displaySha256: z.hash("sha256"),
  }) satisfies z.ZodType<Committed>;
  const snapshot = z.object({ history: z.array(revision) });
  const steps = (fake.evidence.get("journey.jsonl") ?? "")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({ name: z.string(), before: snapshot.optional(), after: snapshot.optional() })
        .parse(JSON.parse(line)),
    );
  assert.equal(steps[0]?.before?.history.length, 2);
  assert.equal(steps.at(-1)?.after?.history.length, 5);
  const initial = steps[0]?.before?.history;
  assert(initial);
  assert.deepEqual(steps.at(-1)?.after?.history.slice(-2), initial);
  assert.match(
    fake.evidence.get("journey.jsonl") ?? "",
    /stopped Workflows ended without a revision/u,
  );
  assert.match(fake.evidence.get("logs.jsonl") ?? "", /cancelled/u);
  assert.match(fake.evidence.get("container.jsonl") ?? "", /"secondsSincePreviousRender":[0-9]/u);
  assert.match(fake.evidence.get("deploy-run.json") ?? "", /success/u);
});
void test("an aborted run's hold and queued work are cleared before the baseline", async () => {
  const fake = staging("aborted run");
  const result = await fake.run();
  assert.equal(result.kind, "pass");
  assert.match(fake.posts[1] ?? "", /queue\/cancel$/u);
  assert.equal(fake.revisions.length, 5);
});
void test("a stopped workflow committing later adds two revisions during redeployment", async () => {
  await assert.rejects(staging("late commit").run(), /added 2 revisions, expected 1/u);
});
void test("a previous revision's display changes", async () => {
  const fake = staging("changed display");
  await assert.rejects(
    fake.run(),
    new RegExp("revision #1 \\(id " + fake.first.id + "\\): display changed", "u"),
  );
});
for (const fault of ["old version", "missed window"] as const) {
  void test(fault + " yields a missed restart", async () => {
    const result = await staging(fault).run();
    assert.equal(result.kind, "missed");
    assert.match(
      result.why,
      fault === "old version" ? /no new DO version/u : /before the held job/u,
    );
  });
}
for (const [fault, message] of [
  ["advance failed", /pattern\.advance_failed/u],
  ["missing hold", /missing hold before stop/u],
  ["parallel deploy", /only unfinished/u],
  ["late adoption", /past start/u],
] as const) {
  void test(fault, async () => {
    const fake = staging(fault);
    await assert.rejects(fake.run(), message);
    if (fault === "parallel deploy" || fault === "late adoption")
      assert.equal(fake.posts.length, 0);
  });
}

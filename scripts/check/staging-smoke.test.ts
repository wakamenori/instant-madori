import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acceptInstructionRequestSchema,
  releaseQueueRequestSchema,
  createProjectRequestSchema,
  displayContentType,
  patternStateResponseSchema,
  renameRequestSchema,
} from "../../packages/contracts/src/index.ts";
import type {
  AcceptedJob,
  FinishedJob,
  PatternStateResponse,
  Revision,
  QueueHold,
} from "../../packages/contracts/src/index.ts";
import { repositoryRoot } from "../shared/repository.ts";
import { smokeStaging, stagingTarget } from "./staging-smoke.ts";

const origin = "https://staging.test";
const token = { clientId: "id", clientSecret: "secret" };
const initialProject = {
  id: "a78de589-a71c-435c-975a-b18539827552",
  name: "Staging smoke",
  version: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const pattern = {
  ...initialProject,
  id: "29dba266-b59c-443c-a296-f06552f34ca6",
  projectId: initialProject.id,
};
type Rewrite = (path: string, method: string, response: Response) => Response | Promise<Response>;

function stagingServer(
  rewrite: Rewrite = (_path, _method, response) => response,
  {
    heldBy,
    outcome = "completed",
  }: { heldBy?: string; outcome?: "completed" | "failed" | "cancelled" | "pending" } = {},
) {
  let project = { ...initialProject };
  const creations = new Map<string, string>();
  const renames = new Set<string>();
  const messages: string[] = [];
  const mutations: string[] = [];
  const revisions: Revision[] = [];
  let runningJob: AcceptedJob | null = null;
  let lastFinishedJob: FinishedJob | null = null;
  let queueHold: QueueHold | null = heldBy
    ? { job: { jobId: heldBy, messageId: crypto.randomUUID(), number: 1, state: "failed" } }
    : null;
  let reads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, origin);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    assert.equal(init?.redirect, "manual", "redirects cannot hide failed authentication");
    assert.ok(init?.signal, "every request has a deadline");
    const viewed = revisions.find(
      (revision) => url.pathname === `/api/revisions/${revision.id}/view`,
    );
    let response: Response;
    if (!headers.has("CF-Access-Client-Id")) {
      response = new Response(null, { status: 302 });
    } else {
      assert.equal(headers.get("CF-Access-Client-Id"), token.clientId);
      assert.equal(headers.get("CF-Access-Client-Secret"), token.clientSecret);
      if (method !== "GET") {
        assert.equal(headers.get("origin"), origin, "mutations pass the Worker's Origin check");
        assert.equal(headers.get("content-type"), "application/json");
      }
      if (url.pathname === "/api/health") {
        response = Response.json({ status: "ok", service: "worker" });
      } else if (url.pathname === "/api/me") {
        response = Response.json({
          user: { id: initialProject.id, email: "verifier@staging.invalid" },
        });
      } else if (url.pathname === "/api/projects" && method === "POST") {
        assert.ok(typeof init?.body === "string");
        const body = createProjectRequestSchema.parse(JSON.parse(init.body));
        const previous = creations.get(body.requestId);
        if (previous !== undefined) assert.equal(init.body, previous);
        creations.set(body.requestId, init.body);
        response = Response.json({ project: initialProject, pattern }, { status: 201 });
      } else if (url.pathname === "/api/projects" && method === "GET") {
        response = Response.json({ projects: [project], nextCursor: null });
      } else if (url.pathname === `/api/projects/${project.id}` && method === "PATCH") {
        assert.ok(typeof init?.body === "string");
        const body = renameRequestSchema.parse(JSON.parse(init.body));
        assert.equal(
          body.version,
          project.version,
          "updates use the current version, not the replay",
        );
        assert.ok(!renames.has(body.requestId), "each run uses a new rename request");
        assert.notEqual(body.name, project.name);
        renames.add(body.requestId);
        project = { ...project, version: project.version + 1, name: body.name };
        response = Response.json({ project });
      } else if (url.pathname === `/api/patterns/${pattern.id}/queue/cancel` && method === "POST") {
        assert.ok(typeof init?.body === "string");
        const cancel = releaseQueueRequestSchema.parse(JSON.parse(init.body));
        assert.equal(cancel.heldBy, queueHold?.job.jobId);
        queueHold = null;
        mutations.push("cancel");
        response = Response.json({ jobs: [] });
      } else if (url.pathname === `/api/patterns/${pattern.id}/messages` && method === "POST") {
        assert.ok(typeof init?.body === "string");
        const message = acceptInstructionRequestSchema.parse(JSON.parse(init.body));
        assert.equal(message.body, "疎通の確認");
        messages.push(message.requestId);
        mutations.push("message");
        runningJob = {
          jobId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          number: messages.length,
        };
        reads = 0;
        response = Response.json({ job: runningJob }, { status: 202 });
      } else if (url.pathname === `/api/patterns/${pattern.id}/state` && method === "GET") {
        if (runningJob && ++reads >= 3 && outcome !== "pending") {
          if (outcome === "completed") {
            const revision = {
              id: crypto.randomUUID(),
              patternId: pattern.id,
              number: revisions.length + 1,
              name: "案",
              baseRevisionId: revisions.at(-1)?.id ?? null,
              createdAt: pattern.createdAt,
            };
            revisions.push(revision);
            lastFinishedJob = { ...runningJob, state: outcome, revision };
          } else {
            lastFinishedJob = { ...runningJob, state: outcome };
          }
          runningJob = null;
        }
        response = Response.json({
          pattern,
          runningJob,
          currentRevision: revisions.at(-1) ?? null,
          queueHold,
          queuedJobs: [],
          lastFinishedJob,
        });
      } else if (viewed && method === "GET") {
        response = new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": displayContentType, "x-revision-id": viewed.id },
        });
      } else if (url.pathname.endsWith("/patterns")) {
        assert.notEqual(url.pathname, `/api/projects/${project.id}/patterns`);
        response = Response.json({ error: "not_found" }, { status: 404 });
      } else {
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }
    }
    return rewrite(url.pathname, method, response);
  };
  const run = (jobTimeoutMs = 2_000) =>
    smokeStaging({ origin, jobTimeoutMs }, token, { fetcher, pollIntervalMs: 1 });
  return { run, creations, renames, messages, mutations, revisions, current: () => project };
}

void test("successive smoke runs reuse one project and add a fresh revision to its fixed pattern", async () => {
  const server = stagingServer();
  await server.run();
  await server.run();
  assert.equal(server.creations.size, 1);
  assert.equal(server.renames.size, 2);
  assert.equal(new Set(server.messages).size, 2);
  assert.deepEqual(
    server.revisions.map((revision) => revision.patternId),
    [pattern.id, pattern.id],
  );
  assert.deepEqual(server.mutations, ["message", "message"]);
  assert.equal(server.current().version, 3);
});

void test("an open Worker, broken health, or rejected verifier fails", async () => {
  for (const rewrite of [
    (_path, _method, response) => (response.status === 302 ? new Response() : response),
    (path, _method, response) =>
      path === "/api/health" && response.status === 200
        ? Response.json({ error: "internal_error" }, { status: 500 })
        : response,
    (path, _method, response) =>
      path === "/api/me" ? Response.json({ error: "forbidden" }, { status: 403 }) : response,
    (path, _method, response) =>
      path === "/api/me"
        ? Response.json({ user: { id: initialProject.id, email: "other@example.com" } })
        : response,
  ] satisfies Rewrite[]) {
    await assert.rejects(stagingServer(rewrite).run());
  }
});

void test("a rename that is not returned or persisted fails", async () => {
  for (const target of ["PATCH", "GET"]) {
    let renamed = false;
    const server = stagingServer((path, method, response) => {
      if (method === "PATCH") {
        renamed = true;
        if (target === "PATCH") return Response.json({ project: initialProject });
      }
      if (target === "GET" && renamed && path === "/api/projects") {
        return Response.json({ projects: [initialProject], nextCursor: null });
      }
      return response;
    });
    await assert.rejects(server.run());
  }
});

void test("a missing project's wrong status or error fails", async () => {
  for (const [status, error] of [
    [200, "not_found"],
    [404, "forbidden"],
  ] as const) {
    const server = stagingServer((path, _method, response) =>
      path.endsWith("/patterns") ? Response.json({ error }, { status }) : response,
    );
    await assert.rejects(server.run());
  }
});

void test("a non-200 view, wrong display media type, or empty view body fails", async () => {
  for (const [broken, failure] of [
    [() => new Response(null, { status: 503 }), /view the committed revision/],
    [
      (response: Response) => {
        const headers = new Headers(response.headers);
        headers.set("content-type", "text/html");
        return new Response("html", { headers });
      },
      /returns display data/,
    ],
    [
      (response: Response) => new Response(null, { headers: response.headers }),
      /display data is not empty/,
    ],
  ] as const) {
    const server = stagingServer((path, _method, response) =>
      path.endsWith("/view") ? broken(response) : response,
    );
    await assert.rejects(server.run(), failure);
  }
});

function rewriteState(change: (state: PatternStateResponse) => PatternStateResponse): Rewrite {
  return async (path, _method, response) =>
    path.endsWith("/state")
      ? Response.json(change(patternStateResponseSchema.parse(await response.json())))
      : response;
}

void test("a reused revision, a stale current revision, or a mislabelled view fails", async () => {
  for (const [label, rewrite, failure] of [
    [
      "the job reports the previous revision",
      (previous: Revision) =>
        rewriteState((state) =>
          state.lastFinishedJob?.state === "completed"
            ? {
                ...state,
                currentRevision: previous,
                lastFinishedJob: { ...state.lastFinishedJob, revision: previous },
              }
            : state,
        ),
      /the job created a new revision/,
    ],
    [
      "the state still shows the previous revision as current",
      (previous: Revision) => rewriteState((state) => ({ ...state, currentRevision: previous })),
      /the completed revision is current/,
    ],
    [
      "the view names another revision",
      (): Rewrite => (path, _method, response) => {
        if (!path.endsWith("/view")) return response;
        const headers = new Headers(response.headers);
        headers.set("x-revision-id", crypto.randomUUID());
        return new Response(response.body, { headers });
      },
      /the view identifies the committed revision/,
    ],
  ] as const) {
    let active: Rewrite = (_path, _method, response) => response;
    const server = stagingServer((path, method, response) => active(path, method, response));
    await server.run();
    const previous = server.revisions[0];
    assert.ok(previous);
    active = rewrite(previous);
    await assert.rejects(server.run(), failure, label);
  }
});

void test("a held queue is cancelled before the new message", async () => {
  const server = stagingServer(undefined, { heldBy: crypto.randomUUID() });
  await server.run();
  assert.deepEqual(server.mutations, ["cancel", "message"]);
});

void test("an unfinished job fails at the deadline", async () => {
  await assert.rejects(stagingServer(undefined, { outcome: "pending" }).run(20), /within 20 ms/);
});

void test("failed and cancelled jobs fail the smoke run", async () => {
  for (const outcome of ["failed", "cancelled"] as const)
    await assert.rejects(stagingServer(undefined, { outcome }).run(), /the accepted job completed/);
});

function config(appOrigins: string) {
  return JSON.stringify({
    env: { staging: { vars: { ENVIRONMENT: "staging", APP_ORIGINS: appOrigins } } },
  });
}

void test("the staging origin comes from the Worker configuration", () => {
  const target = stagingTarget(
    readFileSync(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
  );
  assert.equal(target.jobTimeoutMs, 420_000);
  assert.match(target.origin, /^https:\/\/[^,]+\.workers\.dev$/);
});

void test("APP_ORIGINS uses the Worker's whitespace splitting and requires exactly one origin", () => {
  assert.deepEqual(stagingTarget(config(` \t${origin}\n `)), { origin, jobTimeoutMs: 240_000 });
  for (const value of [
    "",
    " \t\n",
    `${origin} https://other.test`,
    `${origin}\t${origin}`,
    `${origin},https://other.test`,
    `${origin}/path`,
  ]) {
    assert.throws(() => stagingTarget(config(value)));
  }
});

void test("deployment rejects a missing or blank Client ID before migration and masks a valid ID", () => {
  const workflow = readFileSync(
    new URL(".github/workflows/deploy-staging.yml", repositoryRoot),
    "utf8",
  );
  const start = workflow.indexOf("          STAGING_ACCESS_CLIENT_ID=");
  const end = workflow.indexOf("      - name: Smoke test", start);
  assert.ok(start > 0 && end > start);
  const script = workflow
    .slice(start, end)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const directory = mkdtempSync(join(tmpdir(), "madori-smoke-deploy-"));
  try {
    const envFile = join(directory, ".env");
    const commands = join(directory, "commands");
    for (const value of [undefined, "", "   ", "\t", "synthetic-client.access"]) {
      writeFileSync(envFile, value === undefined ? "" : `STAGING_ACCESS_CLIENT_ID=${value}\n`);
      writeFileSync(commands, "");
      const result = spawnSync(
        "bash",
        ["-eu", "-c", `pnpm() { printf '%s\\n' "$*" >> "$COMMANDS_FILE"; }\n${script}`],
        {
          encoding: "utf8",
          env: { ...process.env, MADORI_ENV_FILE: envFile, COMMANDS_FILE: commands },
        },
      );
      if (value === "synthetic-client.access") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `::add-mask::${value}\n`);
        assert.equal(
          readFileSync(commands, "utf8"),
          `exec wrangler d1 migrations apply DB --remote --env staging\nexec node ../../scripts/deploy/wrangler-deploy.ts --env staging --var ACCESS_VERIFIER_CLIENT_ID:${value}\n`,
        );
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /STAGING_ACCESS_CLIENT_ID must not be empty/);
        assert.equal(readFileSync(commands, "utf8"), "");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

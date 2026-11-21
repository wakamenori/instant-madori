import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { githubPollers } from "./github.ts";
import { registry } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";

void test("rebuilds closure labels, PR files and both deployment attempts from allowlisted GitHub responses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = "2026-11-21T00:00:00Z",
    sha = "a".repeat(40),
    second = "b".repeat(40);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const pr = {
    number: 392,
    created_at: at,
    closed_at: at,
    state: "closed",
    merged_at: at,
    head: { ref: "topic", sha },
    base: { ref: "main" },
    merge_commit_sha: second,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    labels: [],
    body: "Closes #263",
  };
  const timeline = [
    { event: "labeled", label: { name: "機能" } },
    { event: "closed", commit_id: sha },
    { event: "reopened" },
    { event: "unlabeled", label: { name: "機能" } },
    { event: "labeled", label: { name: "不具合" } },
    { event: "closed", commit_id: second },
    { event: "unlabeled", label: { name: "不具合" } },
    { event: "reopened" },
    { event: "closed", commit_id: null, node_id: "CLOSE" },
  ].map((e, i) => ({ ...e, created_at: at, id: i + 1 }));
  const run = {
    id: 42,
    event: "push",
    head_sha: second,
    head_branch: "main",
    pull_requests: [],
    created_at: at,
    updated_at: at,
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  };
  const job = (n: number) => ({
    id: n,
    run_attempt: n,
    name: "deploy",
    created_at: at,
    started_at: at,
    completed_at: at,
    status: "completed",
    conclusion: n === 1 ? "failure" : "success",
    runner_name: null,
  });
  let revision = 0;
  const request: typeof fetch = (input, options) => {
    assert.ok(typeof input === "string");
    const url = new URL(input),
      path = url.pathname.replace("/repos/wakamenori/instant-madori/", "");
    let data: unknown;
    if (path === "/rate_limit")
      data = { resources: { core: { remaining: 3000 }, graphql: { remaining: 3000 } } };
    else if (path === "/graphql") {
      assert.ok(typeof options?.body === "string" && options.body.includes("CLOSE"));
      data = {
        data: {
          node: {
            closer: {
              __typename: "PullRequest",
              number: 400,
              repository: { nameWithOwner: "wakamenori/instant-madori" },
              mergeCommit: { oid: sha },
            },
          },
        },
      };
    } else if (path === "issues")
      data = [
        { number: 263, updated_at: at },
        { number: 392, pull_request: {}, updated_at: at },
      ];
    else if (path === "issues/comments") {
      revision++;
      data = [
        {
          id: 52,
          created_at: at,
          user: { login: "fixture" },
          issue_url: "issues/263",
          body: "```yaml\nstarted_at: PRIVATE\n```",
        },
        {
          id: 51,
          created_at: at,
          updated_at: revision === 1 ? at : "2026-11-21T01:00:00Z",
          user: { login: "fixture" },
          issue_url: "issues/263",
          body:
            "```yaml\nstarted_at: 2026-11-21T00:00:00Z\n" +
            (revision === 1 ? "" : "ended_at: 2026-11-21T00:20:00Z\n") +
            "```\nPRIVATE",
        },
      ];
    } else if (path === "issues/263/timeline") data = timeline;
    else if (path.startsWith("commits/")) data = [{ number: path.includes(sha) ? 380 : 392 }];
    else if (path === "pulls/392") data = pr;
    else if (path === "pulls/392/files")
      data = [
        {
          filename: "apps/web/new.ts",
          previous_filename: "old.ts",
          status: "renamed",
          patch: "PRIVATE",
        },
      ];
    else if (path.startsWith("actions/workflows/"))
      data = {
        workflow_runs:
          path.includes("deploy-staging") &&
          url.searchParams.get("created")?.startsWith("2026-11-15")
            ? [run]
            : [],
      };
    else if (path === "actions/runs/42/attempts/1")
      data = { ...run, run_attempt: 1, conclusion: "failure" };
    else if (path === "actions/runs/42/attempts/1/jobs") data = { jobs: [job(1)] };
    else if (path === "actions/runs/42/attempts/2/jobs") data = { jobs: [job(2)] };
    else throw new Error(path);
    return Promise.resolve(Response.json(data, { headers: { "x-ratelimit-remaining": "3000" } }));
  };
  const db = openL1Writer(join(root, "metrics.sqlite"), registry);
  try {
    for (const p of githubPollers(root, () => Promise.resolve("fixture"), request)) {
      if (p.name === "github.issue") continue;
      const records = await p.poll(new AbortController().signal);
      assert.doesNotMatch(JSON.stringify(records), /PRIVATE/u);
      db.ingest(records, new Date(at).toISOString());
      if (p.name === "github.comment") {
        p.committed?.();
        db.ingest(await p.poll(new AbortController().signal), "2026-11-21T02:00:00.000Z");
      }
    }
  } finally {
    db.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "../build/build.ts")], {
    env: { ...process.env, INSTANT_MADORI_METRICS_HOME: root },
  });
  const derived = new DatabaseSync(join(root, "metrics-derived.sqlite"), { readOnly: true });
  try {
    const query = (sql: string) =>
      derived
        .prepare(sql)
        .all()
        .map((r) => Object.values(r));
    assert.deepEqual(
      query("SELECT labels,pr_numbers FROM stg_github_issue_closure ORDER BY event_id"),
      [
        ['["機能"]', "[380]"],
        ['["不具合"]', "[392]"],
        ["[]", "[400]"],
      ],
    );
    assert.deepEqual(
      query("SELECT comment_id,ended_at FROM stg_github_comment_block_history ORDER BY ingest_id"),
      [
        ["51", null],
        ["51", "2026-11-21T00:20:00.000Z"],
      ],
    );
    assert.deepEqual(query("SELECT comment_id,ended_at FROM stg_github_comment_block"), [
      ["51", "2026-11-21T00:20:00.000Z"],
    ]);
    assert.deepEqual(query("SELECT natural_key,reason FROM stg_github_invalid_yaml"), [
      ["52", "invalid_comment_record"],
    ]);
    assert.deepEqual(query("SELECT filename,previous_filename FROM stg_github_pr_file"), [
      ["apps/web/new.ts", "old.ts"],
    ]);
    assert.deepEqual(
      query(
        "SELECT a.run_attempt,a.conclusion,j.run_conclusion,j.name,p.number FROM stg_actions_attempt a JOIN stg_actions_job j USING(run_id,run_attempt) JOIN stg_github_pr p ON p.merge_commit_sha=j.head_sha ORDER BY a.run_attempt",
      ),
      [
        [1, "failure", "failure", "deploy", 392],
        [2, "success", "success", "deploy", 392],
      ],
    );
  } finally {
    derived.close();
  }
});

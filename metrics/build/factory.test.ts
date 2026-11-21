import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registry, type RecordInput } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";
import { parseClassifications } from "../ingest/classification.ts";
import { poissonBounds } from "./poisson.ts";

void test("zero and one completion retain exact two-sided Poisson limits", () => {
  assert.deepEqual(poissonBounds(0).lower, 0);
  assert.ok(Math.abs(poissonBounds(0).upper - 3.688879) < 0.00001);
  assert.ok(Math.abs(poissonBounds(1).lower - 0.025318) < 0.00001);
  assert.ok(Math.abs(poissonBounds(1).upper - 5.57164) < 0.00001);
});

void test("hourly and eight active hour windows count releases, owner gaps and minute states", (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-factory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zero = Date.parse("2026-11-21T00:00:00Z");
  const at = (n: number) => new Date(zero + n * 60_000).toISOString();
  const db = openL1Writer(join(root, "metrics.sqlite"), registry);
  function add(
    source: RecordInput["source"],
    id: string | number,
    payload: RecordInput["payload"],
    observed = at(610),
  ) {
    db.ingest(
      [
        {
          source,
          naturalKey: String(id),
          sourceVersion: "1",
          occurredAt: at(0),
          scope: { kind: "repo" },
          payload,
        },
      ],
      observed,
    );
  }
  let id = 0;
  function timeline(
    issue: number,
    n: number,
    event: string,
    label: string | null = null,
    prs: number[] = [],
  ) {
    add("github.issue.timeline", ++id, { issue, event, created_at: at(n), label, prs });
  }
  function owner(issue: number, key: string, begin: number, end: number) {
    add("t3.thread", key, { issue, title_kind: "owner", created_at: at(begin) });
    add("t3.run", key, { thread_id: key, started_at: at(begin), completed_at: at(end) });
  }
  try {
    add("t3.approval", "approval", {
      thread_id: "gates",
      kind: "tool",
      created_at: at(-70),
      resolved_at: at(-69),
    });
    const head = "a".repeat(40);
    add("github.issue", 20, {
      number: 20,
      created_at: at(-75),
      shared_resources: ["staging を占有する"],
    });
    add("github.issue", 21, { number: 21, created_at: at(-75) }, at(-70));
    for (const n of [21, 22])
      add("github.issue", n, {
        number: n,
        created_at: at(-75),
        shared_resources: n === 21 ? ["staging を占有する"] : [],
      });
    add("github.pr", 30, {
      number: 30,
      head_sha: head,
      closes: [20],
      created_at: at(-70),
      files_complete: true,
      files: [{ filename: "apps/x" }],
    });
    owner(20, "gates", -70, -69);
    add("t3.run", "final", { thread_id: "gates", started_at: at(-15), completed_at: at(-14) });
    add("t3.thread", "codex", {
      parent_thread_id: "gates",
      provider: "codex",
      created_at: at(-69),
    });
    add("t3.run", "implement", { thread_id: "codex", started_at: at(-69), completed_at: at(-68) });
    add("t3.thread", "coord", { created_at: at(-70) });
    add("t3.thread", "inspect", {
      title_kind: "verifier",
      parent_thread_id: "coord",
      issue: 20,
      pr: 30,
      created_at: at(-68),
    });
    add("t3.message", "inspect-verdict", {
      thread_id: "inspect",
      role: "assistant",
      created_at: at(-66),
      verdict: "PASS",
      verification: { head, decided_at: at(-66), failed_checks: [] },
    });
    add("t3.run", "inspect-run", {
      thread_id: "inspect",
      started_at: at(-68),
      completed_at: at(-67),
    });
    add("t3.run", "coord-run", { thread_id: "coord", started_at: at(-64), completed_at: at(-61) });
    add("github.comment", 202, {
      issue_or_pr: 30,
      created_at: at(-60),
      fields: [{ attempt: 1, verdict: "PASS", head, decided_at: at(-66), failed_checks: [] }],
    });
    add("github.actions.attempt", "gates-check", {
      workflow: "check",
      run_id: 9,
      run_attempt: 1,
      head_sha: head,
      created_at: at(-68),
      started_at: at(-67),
      updated_at: at(-65),
      status: "completed",
      conclusion: "success",
    });
    add("github.comment", 203, {
      issue_or_pr: 21,
      created_at: at(-55),
      fields: [{ started_at: at(-65), ended_at: at(-64) }],
    });
    add("github.actions.attempt", "prior-deploy", {
      workflow: "deploy-staging",
      run_id: 10,
      run_attempt: 1,
      head_sha: "unrelated",
      created_at: at(-69),
      started_at: at(-66),
      updated_at: at(-63),
      status: "completed",
      conclusion: "failure",
    });
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9])
      add("github.issue", n, {
        number: n,
        created_at: at(0),
        shared_resources: n >= 7 ? ["staging を占有する"] : [],
        blocked_by: n === 9 ? [{ number: 7 }] : [],
      });
    for (const n of [1, 2, 3, 4]) {
      const pr = n + 10;
      add("github.pr", pr, {
        number: pr,
        merged_at: at(603),
        created_at: at(0),
        head_ref: n === 3 ? "t3/issue-3-fix" : "manual",
        files_complete: true,
        files: n === 1 ? [{ filename: "apps/web/x" }] : [],
        merge_commit_sha: "merge" + n,
        closes: [n],
      });
      timeline(n, 603, "closed", null, [pr]);
    }
    timeline(1, 0, "labeled", "不具合");
    timeline(1, 1, "closed");
    timeline(1, 2, "reopened");
    timeline(1, 600, "unlabeled", "不具合");
    timeline(1, 601, "labeled", "機能：利用者に見える振る舞いを足す・変える");
    timeline(1, 604, "unlabeled", "機能：利用者に見える振る舞いを足す・変える");
    timeline(5, 5, "closed");
    timeline(6, 5, "closed", null, [11]);
    timeline(6, 6, "reopened");
    owner(1, "first", 0, 5);
    owner(1, "second", 600, 607);
    owner(2, "long", 40, 601);
    add("t3.thread", "verifier", { title_kind: "verifier", issue: 1, pr: 11, created_at: at(601) });
    add("t3.run", "verify", { thread_id: "verifier", started_at: at(601), completed_at: at(602) });
    add("github.actions.attempt", "deploy", {
      workflow: "deploy-staging",
      run_id: 8,
      run_attempt: 1,
      head_sha: "merge1",
      created_at: at(603),
      started_at: at(604),
      updated_at: at(605),
      status: "completed",
      conclusion: "success",
    });
    add("github.comment", 201, {
      issue_or_pr: 8,
      created_at: at(605),
      markers: [],
      fields: [{ started_at: at(603), ended_at: at(606) }],
    });
    const file = join(root, "backfill.json");
    writeFileSync(file, JSON.stringify([{ issue: 2, kind: "開発の改善" }]));
    for (const dir of ["tmp", "ready"]) mkdirSync(join(root, "spool", dir), { recursive: true });
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, "../import/classifications.ts"), file],
      { env: { ...process.env, INSTANT_MADORI_METRICS_HOME: root } },
    );
    const ready = join(root, "spool/ready");
    for (const name of readdirSync(ready))
      db.ingest(parseClassifications(readFileSync(join(ready, name))).records, at(610));
  } finally {
    db.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "build.ts")], {
    env: {
      ...process.env,
      INSTANT_MADORI_METRICS_HOME: root,
    },
  });
  const out = new DatabaseSync(join(root, "metrics-derived.sqlite"), { readOnly: true });
  t.after(() => out.close());
  const policy = readFileSync(
    join(import.meta.dirname, "../../.claude/skills/madori-coordinator/SKILL.md"),
    "utf8",
  );
  const capacity = Number(
    out.prepare("SELECT capacity FROM owner_limit ORDER BY effective DESC LIMIT 1").get()?.capacity,
  );
  assert.ok(
    policy.includes(
      "同時に動かす担当は" +
        new Intl.NumberFormat("ja-JP-u-nu-hanidec").format(capacity) +
        "人まで。",
    ),
  );
  const all = (sql: string) =>
    out
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  assert.deepEqual(all("SELECT DISTINCT shared_resources FROM issue_requirements WHERE issue=21"), [
    { shared_resources: '["staging を占有する"]' },
  ]);
  assert.deepEqual(
    all(
      "SELECT issue,ownership,kind_source,area FROM issue_classification WHERE pr IS NOT NULL ORDER BY issue",
    ),
    [
      { issue: 1, ownership: "owner", kind_source: "closure", area: "product" },
      { issue: 2, ownership: "owner", kind_source: "backfill", area: "development" },
      { issue: 3, ownership: "missing_owner", kind_source: null, area: "development" },
      { issue: 4, ownership: "bypass", kind_source: null, area: "development" },
    ],
  );
  assert.deepEqual(
    all("SELECT state FROM mart_minute WHERE issue=20 ORDER BY minute LIMIT 10").map(
      (r) => r.state,
    ),
    [
      "owner_turn",
      "implementer",
      "verifier",
      "ci",
      "check_wait",
      "staging_occupied",
      "deploy_running",
      "coordinator_busy",
      "coordinator_busy",
      "coordinator_asleep",
    ],
  );
  assert.deepEqual(
    all(
      "SELECT reason,slots FROM mart_empty_slot WHERE minute=(SELECT min(minute) FROM mart_active_minute) ORDER BY reason",
    ),
    [
      { reason: "awaiting_dispatch", slots: 1 },
      { reason: "no_ready_issue", slots: 2 },
      { reason: "resource_limit", slots: 1 },
    ],
  );
  assert.deepEqual(
    all("SELECT minutes FROM mart_inactive_stretch WHERE start<unixepoch('2026-11-21')"),
    [{ minutes: 46 }],
  );
  assert.deepEqual(all("SELECT issue,kind,start,end FROM mart_turn_detail"), [
    { issue: 20, kind: "approval", start: at(-70), end: at(-69) },
  ]);
  assert.deepEqual(all("SELECT count(*) n FROM issue_minute WHERE issue=1"), [{ n: 12 }]);
  assert.deepEqual(all("SELECT state,minutes FROM mart_issue_wait WHERE issue=1 ORDER BY state"), [
    { state: "owner_turn", minutes: 7 },
    { state: "post_merge", minutes: 4 },
    { state: "verifier", minutes: 1 },
  ]);
  assert.deepEqual(
    all("SELECT detail FROM mart_minute WHERE issue=1 AND state='post_merge' ORDER BY minute"),
    [
      { detail: "deploy_queued" },
      { detail: "deploy_running" },
      { detail: "staging_occupied" },
      { detail: "owner_check" },
    ],
  );
  assert.deepEqual(all("SELECT previous_kind,kind FROM mart_kind_change"), [
    { previous_kind: "不具合", kind: "機能" },
  ]);
  assert.deepEqual(
    all(
      "SELECT count(*) n FROM mart_kpi WHERE features>0 AND abs(throughput-parallelism*feature_share/hours_per_feature)>1e-10",
    ),
    [{ n: 0 }],
  );
  assert.deepEqual(
    all(
      "SELECT active_minutes,features,feature_minutes,issue_minutes FROM mart_kpi WHERE window='rolling' ORDER BY hour DESC LIMIT 1",
    ),
    [{ active_minutes: 480, features: 1, feature_minutes: 7, issue_minutes: 483 }],
  );
  assert.deepEqual(
    all("SELECT sum(slots) n FROM mart_empty_slot"),
    all("SELECT sum(5-owners) n FROM mart_active_minute"),
  );
  assert.deepEqual(
    all("SELECT count(*) n FROM mart_record_gap WHERE issue=1 AND reason='invalid_verdict'"),
    [{ n: 1 }],
  );
});

void test("a closure on the hour counts even when the factory stops at that boundary", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
 CREATE TABLE settings(window_minutes);INSERT INTO settings VALUES(480);
 CREATE TABLE issue_kind(kind);INSERT INTO issue_kind VALUES('機能');
 CREATE TABLE issue_classification(issue,closed_at,ownership,pr,kind,area);
 INSERT INTO issue_classification VALUES(1,'1970-01-01T01:00:00.000Z','owner',2,'機能','product');
 CREATE TABLE issue_minute(issue,minute);INSERT INTO issue_minute VALUES(1,3540);
 CREATE TABLE mart_active_minute(minute,owners,feature_minutes);INSERT INTO mart_active_minute VALUES(3540,1,1);
 CREATE TABLE owner_interval(issue,start,end);INSERT INTO owner_interval VALUES(1,'1970-01-01T00:59:00.000Z','1970-01-01T01:00:00.000Z');
 `);
  for (const side of ["lower", "upper"] as const)
    db.function("poisson_" + side, (n) => poissonBounds(Number(n))[side]);
  db.exec(readFileSync(join(import.meta.dirname, "../models/marts/05-kpi.sql"), "utf8"));
  assert.deepEqual(
    db
      .prepare(
        "SELECT window,features,active_minutes,throughput FROM mart_kpi WHERE hour=3600 ORDER BY window",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { window: "hour", features: 1, active_minutes: 0, throughput: null },
      { window: "rolling", features: 1, active_minutes: 1, throughput: 60 },
    ],
  );
});

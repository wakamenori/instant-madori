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
import { readViewerData } from "../viewer/data.ts";
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
  const zero = Date.parse("2026-11-23T00:00:00Z");
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
    const improvementLabel = "開発の仕組みの改善：作る・確かめる・届ける・動かす仕組みを良くする";
    for (const issue of [51, 52, 53, 54]) {
      add(
        "github.issue",
        issue,
        {
          number: issue,
          state: "open",
          created_at: at(620),
          labels: [improvementLabel],
          invalid_yaml_record: true,
        },
        at(620),
      );
    }
    for (const issue of [52, 53, 54])
      add("t3.thread", "dispatch-" + issue, {
        issue,
        title_kind: "owner",
        created_at: at(issue === 54 ? 635 : 625),
      });
    add(
      "metrics.receiver",
      "poll-at-dispatch",
      { sources: { "github.issue": { last_poll: at(626) } } },
      at(626),
    );
    for (const issue of [53, 54])
      add(
        "github.issue",
        issue,
        {
          number: issue,
          state: "open",
          created_at: at(620),
          labels: [improvementLabel],
          fields: { type: "開発の仕組みの改善", target: "activity.ci" },
        },
        at(630),
      );
    for (const [id, created_at] of [
      [401, "2026-11-22T01:04:43.999Z"],
      [402, "2026-11-22T01:04:44.000Z"],
    ] as const) {
      add("github.comment", id, { issue_or_pr: id, created_at, markers: ["verdict_pass"] });
    }
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
    add("github.issue", 20, {
      number: 20,
      state: "open",
      created_at: at(-75),
      labels: ["機能：利用者に見える振る舞いを足す・変える"],
      shared_resources: ["staging を占有する"],
    });
    owner(20, "gates", -70, -69);
    add("claude.hook", "session", {
      input: { session_id: "gates" },
      env: { T3CODE_THREAD_ID: "gates" },
    });
    function call(event: string, stop: number, duration: number, command?: string) {
      const fields: Record<string, string> = {
        "session.id": "gates",
        "event.name": event,
        "event.timestamp": at(stop),
        duration_ms: String(duration * 60000),
      };
      if (command)
        Object.assign(fields, {
          tool_name: "Bash",
          tool_parameters: JSON.stringify({ full_command: command }),
        });
      add("claude.otel.log", ++id, {
        log_record: {
          attributes: Object.entries(fields).map(([key, stringValue]) => ({
            key,
            value: { stringValue },
          })),
        },
      });
    }
    call("api_request", -69.5, 0.5);
    call("tool_result", -69.5, 0.5, "pnpm check");
    call("tool_result", -65, 3, "until ready; do sleep 5; done");
    call("tool_result", -15, 1, "until ready; do sleep 5; done");
    add("t3.message", "resume", {
      thread_id: "gates",
      sender_thread_id: "coord",
      role: "user",
      created_at: at(-50),
    });
    add("t3.message", "report", {
      thread_id: "coord",
      sender_thread_id: "gates",
      role: "user",
      created_at: at(-62),
    });
    add("t3.run", "coord-report", {
      thread_id: "coord",
      user_message_id: "report",
      started_at: at(-62),
      completed_at: at(-61),
    });
    add("t3.run", "final", { thread_id: "gates", started_at: at(-15), completed_at: at(-14) });
    add("t3.thread", "codex", {
      parent_thread_id: "gates",
      provider: "codex",
      created_at: at(-69),
    });
    add("t3.run", "implement", { thread_id: "codex", started_at: at(-69), completed_at: at(-68) });
    add("t3.thread", "coord", { created_at: at(-70) });
    add("t3.thread", "inspect", {
      provider: "claudeAgent",
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
    add("t3.approval", "permission", {
      thread_id: "inspect",
      kind: "command",
      status: "resolved",
      decision: "accept",
      created_at: at(-68),
      resolved_at: at(-67),
    });
    add("t3.run", "coord-run", { thread_id: "coord", started_at: at(-64), completed_at: at(-61) });
    add("github.comment", 202, {
      issue_or_pr: 30,
      created_at: at(-62),
      fields: [{ attempt: 1, verdict: "PASS", head, decided_at: at(-66), failed_checks: [] }],
    });
    add("github.actions.attempt", "gates-check", {
      workflow: "check",
      run_id: 9,
      run_attempt: 1,
      head_sha: head,
      created_at: at(-69),
      started_at: at(-68),
      updated_at: at(-65),
      status: "completed",
      conclusion: "success",
    });
    const checkRun = {
      workflow: "check",
      run_id: 9,
      run_attempt: 1,
      head_sha: head,
      pr_numbers: [30],
    };
    add("github.actions.job", 901, {
      ...checkRun,
      name: "mode",
      created_at: at(-69),
      started_at: at(-68),
      completed_at: at(-67),
    });
    add("github.actions.job", 902, {
      ...checkRun,
      name: "check",
      created_at: at(-67),
      started_at: at(-66),
      completed_at: at(-65),
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
    const mergedFiles = [
      { issue: 1, files: [{ filename: "scripts/dev/x", previous_filename: "apps/web/x" }] },
      { issue: 2, files: [{ filename: "scripts/dev/x" }] },
      { issue: 3, files: [{ filename: "scripts/dev/x" }] },
      { issue: 4, files: [{ filename: "crates/display/x" }] },
      { issue: 31, files: [{ filename: "scripts/dev/x" }] },
      { issue: 32, files: [{ filename: "packages/contracts/x" }] },
      { issue: 33, files: [{ filename: "packages/contracts/x", previous_filename: "scripts/x" }] },
      { issue: 34, files: [{ filename: "apps/web/x" }] },
    ];
    for (const n of [31, 32, 33, 34]) add("github.issue", n, { number: n, created_at: at(0) });
    for (const { issue: n, files } of mergedFiles) {
      const pr = n + 10;
      add("github.pr", pr, {
        number: pr,
        merged_at: at(603),
        created_at: at(0),
        head_ref: n === 3 ? "t3/issue-3-fix" : "manual",
        files_complete: n !== 31,
        files,
        merge_commit_sha: "merge" + n,
        closes: [n],
      });
      timeline(n, 603, "closed", null, [pr]);
    }
    for (const [attempt, head, verdict, push, decision] of [
      [1, "b".repeat(40), "FAIL", 45, 55],
      [2, "c".repeat(40), "PASS", 65, 75],
    ] as const) {
      add("github.actions.attempt", "phase-" + attempt, {
        workflow: "check",
        run_attempt: 1,
        head_sha: head,
        created_at: at(push),
      });
      add("github.comment", 300 + attempt, {
        issue_or_pr: 12,
        created_at: at(decision),
        fields: [{ attempt, verdict, head: head.slice(0, 8), decided_at: at(decision) }],
      });
    }
    timeline(31, 1, "labeled", "製品の不具合：約束どおりに動かない製品を直す");
    timeline(32, 1, "labeled", "確かめと判断：試作・計測・受け入れ・計画づくりで知る・決める");
    timeline(33, 1, "labeled", "開発の仕組みの作りの見直し：振る舞いを変えずに作りを変える");
    timeline(3, 1, "labeled", "製品の作りの見直し：振る舞いを変えずに作りを変える");
    timeline(4, 1, "labeled", "開発の仕組みの不具合：約束どおりに動かない仕組みを直す");
    timeline(1, 0, "labeled", "製品の不具合：約束どおりに動かない製品を直す");
    timeline(1, 1, "closed");
    timeline(1, 2, "reopened");
    timeline(1, 600, "unlabeled", "製品の不具合：約束どおりに動かない製品を直す");
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
    writeFileSync(
      file,
      JSON.stringify([
        {
          issue: 2,
          kind: "開発の仕組みの作りの見直し",
          found_at: "マージの後",
          found_by: "検証役",
          cause: "外の変化",
          plan_change: "いいえ",
        },
      ]),
    );
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
  const viewer = readViewerData(out);
  const eight = viewer.windows.find((w) => w.length === 8);
  assert.ok(eight);
  assert.ok(eight.points.some((p) => p.features > 0 && p.active_minutes === 480));
  assert.ok(viewer.windows.every((w) => w.points.every((p) => p.active_minutes === w.length * 60)));
  for (const point of eight.points) {
    const rolling = out
      .prepare(
        "SELECT * FROM mart_kpi WHERE window='rolling' AND span=8 AND target='機能' AND end=?",
      )
      .get(point.end);
    assert.ok(rolling);
    for (const key of [
      "start",
      "active_minutes",
      "issue_minutes",
      "feature_minutes",
      "features",
      "open_start",
      "open_end",
      "throughput",
      "parallelism",
      "feature_share",
      "throughput_low",
      "throughput_high",
    ] as const)
      assert.equal(point[key], rolling[key], key);
    assert.equal(point.hours_per_feature, rolling.hours_per_completion);
    assert.equal(point.hours_per_feature_low, rolling.hours_per_completion_low);
    assert.equal(point.hours_per_feature_high, rolling.hours_per_completion_high);
    assert.equal(
      point.kinds.reduce((sum, r) => sum + r.minutes, 0),
      point.issue_minutes,
    );
    assert.equal(
      point.states.reduce((sum, r) => sum + r.minutes, 0),
      point.feature_minutes,
    );
    const completed = out
      .prepare(
        "SELECT count(*) n FROM mart_quality_issue q JOIN issue_classification c USING(issue) WHERE unixepoch(c.closed_at)>=? AND unixepoch(c.closed_at)<? AND q.area='product'",
      )
      .get(point.start, point.end);
    assert.equal(point.quality.find((q) => q.area === "product")?.total, completed?.n);
  }
  const skill = ".claude/skills/madori-coordinator/SKILL.md";
  const repo = join(import.meta.dirname, "../..");
  const policy = readFileSync(join(repo, skill), "utf8");
  const verification = out.prepare("SELECT effective,revision FROM verification_policy").get();
  assert.ok(verification);
  const rule = "検証は、head ごとに検証役一人で行う。";
  assert.ok(policy.includes(rule));
  const revision = String(verification.revision);
  const introduced = execFileSync("git", ["show", "--format=", revision, "--", skill], {
    encoding: "utf8",
    cwd: repo,
  });
  assert.ok(introduced.split("\n").some((line) => line.startsWith("+") && line.includes(rule)));
  const commitTime = execFileSync("git", ["show", "-s", "--format=%cI", revision], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(verification.effective, new Date(commitTime.trim()).toISOString());
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
  assert.deepEqual(
    all("SELECT type,found_by,disposition,plan_change FROM quality_discovery WHERE report_issue=2"),
    [
      {
        type: "開発の仕組みの作りの見直し",
        found_by: "検証役",
        disposition: "外の変化",
        plan_change: "いいえ",
      },
    ],
  );
  assert.deepEqual(
    all("SELECT issue,reason FROM mart_record_gap WHERE issue BETWEEN 51 AND 54 ORDER BY issue"),
    [
      { issue: 52, reason: "missing_dispatch_target" },
      { issue: 53, reason: "missing_dispatch_target" },
    ],
  );
  assert.deepEqual(all("SELECT issue FROM mart_record_gap WHERE issue IN (401,402)"), [
    { issue: 402 },
  ]);
  assert.deepEqual(all("SELECT kind,kind_source FROM issue_classification WHERE issue=20"), [
    { kind: "機能", kind_source: "current" },
  ]);
  assert.deepEqual(
    all("SELECT issue FROM mart_record_gap WHERE reason='missing_kind' AND issue=2"),
    [],
  );
  assert.deepEqual(
    all("SELECT actor,kind FROM span WHERE kind IN ('ci_queue','ci_run') ORDER BY kind,actor"),
    [
      { actor: "901", kind: "ci_queue" },
      { actor: "902", kind: "ci_queue" },
      { actor: "9/1", kind: "ci_run" },
    ],
  );
  assert.deepEqual(all("SELECT job_id FROM mart_ci_job WHERE workflow='check'"), [{ job_id: 902 }]);
  assert.deepEqual(all("SELECT check_jobs FROM mart_issue_flow WHERE issue=20"), [
    { check_jobs: 1 },
  ]);
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
      { issue: 3, ownership: "missing_owner", kind_source: "closure", area: "product" },
      { issue: 4, ownership: "bypass", kind_source: "closure", area: "development" },
      { issue: 31, ownership: "bypass", kind_source: "closure", area: "product" },
      { issue: 32, ownership: "bypass", kind_source: "closure", area: null },
      { issue: 33, ownership: "bypass", kind_source: "closure", area: "development" },
      { issue: 34, ownership: "bypass", kind_source: null, area: null },
    ],
  );
  assert.deepEqual(
    all("SELECT issue FROM mart_record_gap WHERE reason='label_file_mismatch' ORDER BY issue"),
    [{ issue: 3 }, { issue: 4 }],
  );
  assert.deepEqual(
    all("SELECT DISTINCT kind FROM mart_kind_period WHERE kind<>'unknown' ORDER BY kind").map(
      (row) => row.kind,
    ),
    [
      "機能",
      "製品の不具合",
      "製品の作りの見直し",
      "開発の仕組みの改善",
      "開発の仕組みの不具合",
      "開発の仕組みの作りの見直し",
      "外の変化への追従",
      "確かめと判断",
    ].sort(),
  );
  assert.deepEqual(
    all("SELECT count(*) n FROM mart_minute"),
    all("SELECT count(*) n FROM issue_minute"),
  );
  const expected = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const row of all("SELECT issue,start,end FROM owner_interval ORDER BY issue,start")) {
    const issue = Number(row.issue);
    const start = Math.max(
      Date.parse(String(row.start)),
      Date.parse("2026-11-21T12:21:00Z"),
      ends.get(issue) ?? 0,
    );
    const end = Date.parse(String(row.end));
    if (end > start) {
      expected.set(issue, (expected.get(issue) ?? 0) + end - start);
      ends.set(issue, end);
    }
  }
  assert.deepEqual(
    all("SELECT issue,sum(ms) ms FROM mart_effort_interval GROUP BY issue ORDER BY issue"),
    Array.from(expected, ([issue, ms]) => ({ issue, ms })),
  );
  const interval = (minute: number) =>
    out
      .prepare(
        "SELECT tier,wait_detail,ci_ms,generation_ms,local_ms,ms FROM mart_effort_interval WHERE issue=20 AND start<=? AND end>?",
      )
      .get(at(minute), at(minute));
  const overlap = interval(-70);
  assert.equal(overlap?.tier, "work");
  assert.ok(Number(overlap?.generation_ms) + Number(overlap?.local_ms) > Number(overlap?.ms));
  assert.equal(interval(-67)?.tier, "work");
  assert.ok(Number(interval(-67)?.ci_ms) > 0);
  assert.equal(interval(-16)?.tier, "unclassified");
  assert.deepEqual(
    [-62, -63, -58].map((n) => interval(n)?.wait_detail),
    ["this_issue", "elsewhere", "stopped"],
  );
  assert.deepEqual(all("SELECT start,phase FROM issue_phase WHERE issue=2 ORDER BY start"), [
    { start: at(40), phase: "implementation" },
    { start: at(45), phase: "verification" },
    { start: at(55), phase: "rework" },
    { start: at(65), phase: "verification" },
    { start: at(75), phase: "merge_wait" },
    { start: at(603), phase: "post_merge" },
  ]);
  assert.deepEqual(
    all(
      "SELECT phase FROM mart_effort_interval WHERE issue=2 GROUP BY phase ORDER BY min(start)",
    ).map((r) => r.phase),
    ["implementation", "verification", "rework", "merge_wait"],
  );
  assert.equal(
    out
      .prepare(
        "SELECT min(start) start FROM mart_effort_interval WHERE issue=1 AND phase='post_merge'",
      )
      .get()?.start,
    at(603),
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
    all("SELECT minutes FROM mart_inactive_stretch WHERE start<unixepoch('2026-11-23')"),
    [{ minutes: 46 }],
  );
  assert.deepEqual(
    all("SELECT issue,kind,start,end FROM mart_turn_detail WHERE kind='approval' ORDER BY start"),
    [
      { issue: 20, kind: "approval", start: at(-70), end: at(-69) },
      { issue: 20, kind: "approval", start: at(-68), end: at(-67) },
    ],
  );
  assert.deepEqual(all("SELECT unit,direction FROM improvement_target WHERE id='approval.wait'"), [
    { unit: "割合", direction: "down" },
  ]);
  assert.deepEqual(
    all("SELECT minute,hits FROM target_sample WHERE target='approval.wait' ORDER BY minute"),
    [
      { minute: Date.parse(at(-70)) / 1000, hits: 1 },
      { minute: Date.parse(at(-68)) / 1000, hits: 1 },
    ],
  );
  assert.deepEqual(all("SELECT count(*) n FROM issue_minute WHERE issue=1"), [{ n: 12 }]);
  assert.deepEqual(all("SELECT previous_kind,kind FROM mart_kind_change"), [
    { previous_kind: "製品の不具合", kind: "機能" },
  ]);
  for (const span of [4, 8, 24]) {
    for (const target of ["機能", "全種類"]) {
      const rows = out
        .prepare(
          `
        SELECT abs(throughput-parallelism*target_share/hours_per_completion) error
        FROM mart_kpi WHERE window='rolling' AND span=? AND target=? AND completions>0
      `,
        )
        .all(span, target);
      assert.ok(rows.length > 0, span + "h " + target);
      for (const { error } of rows) assert.ok(typeof error === "number" && error < 1e-10);
    }
  }
  assert.deepEqual(
    all("SELECT DISTINCT target_share FROM mart_kpi WHERE target='全種類' AND issue_minutes>0"),
    [{ target_share: 1 }],
  );
  assert.deepEqual(
    all(
      "SELECT active_minutes,features,feature_minutes,issue_minutes FROM mart_kpi WHERE window='rolling' AND span=8 AND target='機能' ORDER BY hour DESC LIMIT 1",
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

function buildKpiFixture(db: DatabaseSync, records: string) {
  db.exec(`
    CREATE TABLE issue_kind(kind); INSERT INTO issue_kind VALUES('機能');
    CREATE TABLE issue_classification(issue,closed_at,ownership,pr,kind,area);
    CREATE TABLE issue_minute(issue,minute);
    CREATE TABLE mart_active_minute(minute,owners,feature_minutes);
    CREATE TABLE owner_interval(issue,start,end);
  `);
  db.exec(records);
  for (const side of ["lower", "upper"] as const)
    db.function("poisson_" + side, (n) => poissonBounds(Number(n))[side]);
  db.exec(readFileSync(join(import.meta.dirname, "../models/marts/05-kpi.sql"), "utf8"));
}

void test("a closure on the hour counts even when the factory stops at that boundary", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  buildKpiFixture(
    db,
    `
    INSERT INTO issue_classification VALUES(1,'2026-11-22T01:00:00Z','owner',2,'機能','product');
    INSERT INTO issue_minute VALUES(1,unixepoch('2026-11-22T00:59:00Z'));
    INSERT INTO mart_active_minute SELECT minute,1,1 FROM issue_minute;
  `,
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT window,features,active_minutes,throughput FROM mart_kpi
      WHERE hour=unixepoch('2026-11-22T01:00:00Z') AND target='機能' AND (span IS NULL OR span=8)
      ORDER BY window
    `,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { window: "hour", features: 1, active_minutes: 0, throughput: null },
      { window: "rolling", features: 1, active_minutes: 1, throughput: 60 },
    ],
  );
});

void test("rolling periods start at the cutoff while the viewer retains the full hour", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  buildKpiFixture(
    db,
    `
    INSERT INTO issue_classification VALUES
      (1,'2026-11-21T12:20:59Z','owner',11,'機能','product'),
      (2,'2026-11-21T12:21:00Z','owner',12,'機能','product'),
      (3,'2026-11-21T12:22:00Z','owner',13,NULL,NULL);
    INSERT INTO issue_minute VALUES(1,1795263660-3600),(1,1795263660-60),(2,1795263660),(3,1795263660+60);
    INSERT INTO mart_active_minute SELECT minute,1,issue<>3 FROM issue_minute;
  `,
  );
  assert.deepEqual(
    db.prepare("SELECT hour FROM mart_kpi WHERE window='rolling' AND end<=1795263660").all(),
    [],
  );
  const rows = db
    .prepare(
      `
    SELECT window,span,target,active_minutes,issue_minutes,completions,target_minutes FROM mart_kpi
    WHERE hour=unixepoch('2026-11-21T12:00:00Z') ORDER BY span,target
  `,
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      window: "hour",
      span: null,
      target: "機能",
      active_minutes: 3,
      issue_minutes: 3,
      completions: 2,
      target_minutes: 2,
    },
    ...[4, 8, 24].flatMap((span) => [
      {
        window: "rolling",
        span,
        target: "全種類",
        active_minutes: 2,
        issue_minutes: 2,
        completions: 2,
        target_minutes: 2,
      },
      {
        window: "rolling",
        span,
        target: "機能",
        active_minutes: 2,
        issue_minutes: 2,
        completions: 1,
        target_minutes: 1,
      },
    ]),
  ]);
});

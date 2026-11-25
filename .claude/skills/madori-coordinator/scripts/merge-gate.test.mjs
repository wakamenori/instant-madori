import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGitHub, isolatedEnv, repository, runScript, tempDir } from "./testing/support.mjs";

const workflow = ".github/workflows/deploy-staging.yml";
const dispatch = "gh workflow run deploy-staging.yml --ref main";
function setup({ docs = false, date = "2020-01-01T00:00:00Z" } = {}) {
  const env = isolatedEnv(tempDir());
  const repo = repository(
    { [workflow]: readFileSync(new URL("../../../../" + workflow, import.meta.url)) },
    env,
  );
  const main = repo.commit(
    { code: "release" },
    { date, subject: "Merge pull request #6 from branch" },
  );
  repo.pushMain();
  repo.branch("pr", "main");
  repo.commit(docs ? { "docs/fix.md": "fix" } : { code: "next" });
  const head = repo.pushPull(7);
  repo.checkout("main");
  const runs = {};
  const jobs = {
    11: [
      {
        steps: [
          { name: "Setup", conclusion: "success" },
          { name: "Run pnpm check --full", conclusion: "failure" },
        ],
      },
    ],
  };
  const call = (args) =>
    runScript("merge-gate.mjs", args, {
      cwd: repo.coordinator,
      env: fakeGitHub(tempDir(), { runs, jobs }, env).env,
    });
  return {
    repo,
    main,
    head,
    runs,
    jobs,
    check: (...flags) => call(["check", "7", head, ...flags]),
    status: (...flags) => call(["status", ...flags]),
  };
}

function run(sha, conclusion, id = 11, branch = "main") {
  return {
    head_sha: sha,
    created_at: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    head_branch: branch,
    id,
    html_url: `https://example.org/runs/${id}`,
    status: conclusion ? "completed" : "queued",
    conclusion,
  };
}

function expect(result, status, ...lines) {
  assert.equal(result.status, status, result.stderr || result.stdout);
  for (const line of lines) assert.ok(result.stdout.includes(line), result.stdout);
}

void test("a red release blocks deploying changes except the named fix, then waits for its deploy", () => {
  const f = setup();
  f.runs[f.main] = [run(f.main, "failure")];
  expect(
    f.check(),
    3,
    `wait\ndeploys: yes\nmain: red ${f.main.slice(0, 7)} #6 run 11 https://example.org/runs/11 step: Run pnpm check --full`,
    "--fixes 11",
    dispatch,
  );
  expect(f.check("--fixes", "12"), 3, "--fixes 12 does not match failed run 11");
  expect(f.check("--fixes", "11"), 0, "merge\ndeploys: yes");
  const merged = f.repo.merge("pr", 7);
  f.runs[merged] = [run(merged, null, 12)];
  expect(f.status(), 0, "main: running", "Wait for run 12");
  assert.equal(f.check().status, 1);
  expect(f.check("--at", f.main), 3, "main: red");
});

void test("docs-only changes merge on red, running and unchecked main", () => {
  const f = setup({ docs: true });
  for (const [state, runs] of [
    ["red", [run(f.main, "failure")]],
    ["running", [run(f.main, null)]],
    ["unchecked", []],
  ]) {
    f.runs[f.main] = runs;
    expect(f.check(), 0, `merge\ndeploys: no\nmain: ${state}`);
  }
});

void test("a release without a run gets five minutes for GitHub to create it", () => {
  const recent = setup({ date: new Date().toISOString() });
  expect(recent.check(), 3, "main: running", "push run has not appeared");
  const older = setup();
  expect(older.check(), 3, "main: unchecked", "no run", dispatch);
  older.runs[older.main] = [run(older.main, null)];
  expect(older.check(), 3, "main: running", "Wait for run 11");
});

void test("a dispatch on a docs tip can recover a cancelled or failed deploy", () => {
  const f = setup();
  f.runs[f.main] = [run(f.main, "cancelled")];
  expect(f.check(), 3, "main: unchecked", "cancelled");
  const tip = f.repo.commit({ "docs/fix.md": "fix" });
  f.repo.pushMain();
  f.runs[f.main] = [run(f.main, "failure")];
  expect(f.status(), 0, "main: red", "If a later commit fixes it", dispatch);
  for (const previous of ["cancelled", "failure"]) {
    f.runs[f.main] = [run(f.main, previous)];
    f.runs[tip] = [run(tip, "success", 12)];
    expect(f.check(), 0, `merge\ndeploys: yes\nmain: green ${tip.slice(0, 7)}`);
  }
  f.runs[f.main] = [run(f.main, "success", 13)];
  f.runs[tip] = [run(tip, "failure")];
  expect(f.check(), 3, `main: red ${tip.slice(0, 7)}`);
});

void test("the newest non-cancelled run on main decides for one commit", () => {
  const f = setup();
  f.runs[f.main] = [
    run(f.main, "failure", 13, "trial"),
    run(f.main, "failure"),
    run(f.main, "success", 12),
  ];
  expect(f.check(), 0, "main: green", "run 12");
  f.runs[f.main].push(run(f.main, "timed_out", 14), run(f.main, "skipped", 15));
  expect(f.check(), 3, "main: red", "run 14");
});

void test("invalid GitHub data or an unrelated --at leaves the gate undecided", () => {
  const f = setup();
  f.runs[f.main] = [{ head_branch: "main", head_sha: f.main }];
  assert.equal(f.check().status, 1);
  f.runs[f.main] = [run(f.main, "failure")];
  f.jobs[11] = [{}];
  assert.equal(f.status().status, 1);
  f.runs[f.main] = [run(f.main, "success")];
  assert.equal(f.status("--at", f.head).status, 1);
});

void test("usage errors precede Git and GitHub access", () => {
  const home = tempDir();
  const env = isolatedEnv(home);
  const gitLog = join(home, "git-called");
  writeFileSync(join(home, "bin", "git"), `#!/bin/sh\n: > "${gitLog}"\nexit 1\n`, {
    mode: 0o755,
  });
  const gh = fakeGitHub(home, {}, env);
  const sha = "a".repeat(40);
  for (const args of [
    [],
    ["status", "--fixes", "1"],
    ["status", "--at"],
    ["check", "-1", sha],
    ["check", "1", "bad"],
    ["check", "1", sha, "--fixes", "0"],
    ["check", "1", sha, "--at", sha, "--at", sha],
  ]) {
    const result = runScript("merge-gate.mjs", args, { cwd: home, env: gh.env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^merge-gate: usage:/);
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(gitLog), false);
  assert.deepEqual(gh.calls(), []);
});

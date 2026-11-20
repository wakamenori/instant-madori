import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport, selectArtifacts, verdict } from "./test-history.ts";

function obs(
  outcome: "pass" | "fail" | "skip",
  headBranch: string,
  runId: number,
  headSha = String(runId),
  attempt = 1,
) {
  return {
    outcome,
    headBranch,
    runId,
    headSha,
    attempt,
    workflow: headBranch === "main" ? "deploy-staging" : "check",
  };
}
void test("a rerun flip on a PR gives both attempts as evidence", () => {
  const v = verdict([obs("fail", "pr", 12), obs("pass", "pr", 12, "12", 2)]);
  assert.equal(v.kind, "flaky");
  assert.match(v.evidence, /12\/2.*12\/1/u);
});
void test("the Container incident has one main failure in eight runs", () => {
  const runs = [
    ...Array.from({ length: 7 }, (_, i) => obs("pass", "main", i)),
    obs("fail", "main", 7),
  ];
  const report = formatReport(new Map([["container: real Container", runs]]), false);
  assert.match(
    report,
    /flaky +1\/8 failed \(12.5%\).*7 pass, 1 fail.*main failures: deploy-staging 7\/1/u,
  );
});
void test("verdict separates branch-only failures, multiple branches, and no passes", () => {
  const pass = obs("pass", "main", 1),
    fail = obs("fail", "pr", 2);
  assert.deepEqual(verdict([pass, fail]), { kind: "branch-local", branch: "pr" });
  assert.deepEqual(verdict([pass, fail, obs("fail", "fix", 3)]), {
    kind: "suspect",
    branches: ["fix", "pr"],
  });
  assert.deepEqual(verdict([fail, obs("skip", "main", 3)]), { kind: "failing" });
  assert.deepEqual(verdict([pass]), { kind: "stable" });
});
void test("report filters stable rows, excludes skips, orders verdicts and splits workflows", () => {
  const tests = new Map([
    ["typescript: stable", [obs("pass", "main", 1)]],
    ["container: broken", [obs("fail", "pr", 2)]],
    ["rust: mixed", [obs("pass", "main", 1), obs("fail", "pr", 1), obs("skip", "pr", 2)]],
  ]);
  const report = formatReport(tests, false);
  assert.match(
    report,
    /^flaky +1\/2.*check: 0 pass, 1 fail; deploy-staging: 1 pass, 0 fail.*\nfailing/u,
  );
  assert.doesNotMatch(report, /stable/u);
  assert.match(formatReport(tests, true), /\nstable/u);
  assert.match(formatReport(tests, false, "typescript"), /^stable[^\n]+$/u);
});

void test("artifact selection reads workflow and attempt from current, retained results", () => {
  const current = {
    name: "test-results-v1-deploy-staging-2",
    expired: false,
    id: 42,
    created_at: "2026-11-21T00:00:00Z",
    workflow_run: { id: 5, head_sha: "abc", head_branch: "main" },
  };
  assert.deepEqual(
    selectArtifacts(
      [
        { name: "other", expired: false },
        { ...current, expired: true },
        current,
        { ...current, id: 1, created_at: "2026-11-20T00:00:00Z" },
      ],
      1,
    ),
    [
      {
        name: current.name,
        id: 42,
        created: current.created_at,
        run: {
          workflow: "deploy-staging",
          attempt: 2,
          runId: 5,
          headSha: "abc",
          headBranch: "main",
        },
      },
    ],
  );
  assert.throws(() => selectArtifacts([{ ...current, workflow_run: {} }], 1));
});
void test("a main failure with passes only on a different PR commit needs investigation", () => {
  assert.deepEqual(verdict([obs("fail", "main", 1), obs("pass", "pr", 2)]), {
    kind: "suspect",
    branches: ["main"],
  });
});

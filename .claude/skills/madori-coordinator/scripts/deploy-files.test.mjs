import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeGitHub, isolatedEnv, repository, runScript, tempDir } from "./testing/support.mjs";

const workflowPath = ".github/workflows/deploy-staging.yml";
const workflow = readFileSync(new URL(`../../../../${workflowPath}`, import.meta.url), "utf8");
const without = (entry) => {
  const line = `      - "${entry}"\n`;
  assert(workflow.includes(line), `the real paths-ignore lists ${entry}`);
  return workflow.replace(line, "");
};
const base = {
  [workflowPath]: workflow,
  "apps/web/src/main.ts": "main\n",
  "docs/plan.md": "plan\n",
  "README.md": "readme\n",
};

function setup(files = base) {
  const home = tempDir();
  const env = isolatedEnv(home);
  const repo = repository(files, env);
  const github = (prs = {}) => fakeGitHub(tempDir(), { prs }, env);
  return { repo, github };
}

const before = (repo, gh, pr, head) =>
  runScript("deploy-files.mjs", ["before", String(pr), head], {
    cwd: repo.coordinator,
    env: gh.env,
  });
const after = (repo, gh, pr) =>
  runScript("deploy-files.mjs", ["after", String(pr)], { cwd: repo.coordinator, env: gh.env });

function pr(repo, changes) {
  repo.branch("pr", "main");
  repo.commit(changes);
  return repo.pushPull(7);
}

const docsOnly = {
  "docs/plan.md": "plan 2\n",
  "README.md": "readme 2\n",
  "CLAUDE.md": "claude",
  "AGENTS.md": "agents\n",
  ".claude/skills/x/SKILL.md": "skill\n",
  ".github/ISSUE_TEMPLATE/unit.md": "template\n",
};
const withCode = {
  "docs/plan.md": "plan 2\n",
  "apps/web/src/main.ts": "main 2\n",
  "apps/web/README.md": "nested",
  "scripts/check/new.ts": "new\n",
  "apps/AGENTS.md": "only the root AGENTS.md is ignored\n",
};
const withCodeFiles =
  "apps/AGENTS.md\napps/web/README.md\napps/web/src/main.ts\nscripts/check/new.ts\n";

void test("before: a docs-only PR prints nothing and asks GitHub nothing", () => {
  const { repo, github } = setup();
  const gh = github();
  const result = before(repo, gh, 7, pr(repo, docsOnly));
  assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  assert.deepEqual(gh.calls(), []);
});

void test("before: a PR with code prints exactly its files outside paths-ignore", () => {
  const { repo, github } = setup();
  const result = before(repo, github(), 7, pr(repo, withCode));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, withCodeFiles);
});

void test("before: an unreadable list makes every changed file count, with a warning", () => {
  const { [workflowPath]: _, ...noWorkflow } = base;
  const unreadable = {
    "workflow missing": noWorkflow,
    "header renamed": {
      ...base,
      [workflowPath]: workflow.replace("    paths-ignore:", "    paths_ignore:"),
    },
    "entries in single quotes": {
      ...base,
      [workflowPath]: workflow.replaceAll(/- "(.*)"/g, "- '$1'"),
    },
  };
  for (const [name, files] of Object.entries(unreadable)) {
    const { repo, github } = setup(files);
    const result = before(
      repo,
      github(),
      7,
      pr(repo, { "docs/plan.md": "plan 2\n", "apps/web/src/main.ts": "main 2\n" }),
    );
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, "apps/web/src/main.ts\ndocs/plan.md\n", name);
    assert.match(result.stderr, /cannot read paths-ignore/, name);
  }
});

void test("before: the list ends at the next key, and a comment inside it does not end it", () => {
  const branches = "    branches: [main]\n";
  const last = '      - "README.md"\n';
  assert(workflow.includes(branches) && workflow.includes(last), "the real push filters");
  const laterList = workflow
    .replace(branches, "")
    .replace(last, last + '    branches:\n      - "release"\n');
  const commented = workflow.replace('      - ".claude/**"\n', '      - ".claude/**"\n  # note\n');
  for (const [name, list, changes, expected] of [
    ["a later list", laterList, { release: "root file\n" }, "release\n"],
    ["a comment", commented, { "README.md": "readme 2\n" }, ""],
  ]) {
    const { repo, github } = setup({ ...base, [workflowPath]: list });
    const result = before(repo, github(), 7, pr(repo, changes));
    assert.deepEqual(result, { status: 0, stdout: expected, stderr: "" }, name);
  }
});

void test("before: a head with no merge base fails instead of printing nothing", () => {
  const { repo, github } = setup();
  repo.orphan("pr");
  repo.commit({ "docs/plan.md": "unrelated history\n" });
  const result = before(repo, github(), 7, repo.pushPull(7));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

void test("before: the list is origin/main's as fetched now, not the PR's or a stale clone's", () => {
  const { repo, github } = setup({ ...base, [workflowPath]: without("docs/**") });
  repo.commit({ [workflowPath]: workflow });
  repo.pushMain();
  repo.branch("pr", "main~1");
  repo.commit({
    [workflowPath]: without("docs/**").replace(
      '      - "README.md"\n',
      '      - "README.md"\n      - "apps/**"\n',
    ),
    "docs/new.md": "new\n",
    "apps/web/src/main.ts": "main 2\n",
  });
  const result = before(repo, github(), 7, repo.pushPull(7));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${workflowPath}\napps/web/src/main.ts\n`);
});

void test("before: changes main made after the PR branched do not count", () => {
  const { repo, github } = setup();
  const head = pr(repo, { "docs/plan.md": "plan 2\n" });
  repo.checkout("main");
  repo.commit({ "apps/web/src/main.ts": "changed on main\n" });
  repo.pushMain();
  const result = before(repo, github(), 7, head);
  assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
});

void test("before: a rename counts its old and new paths", () => {
  const { repo, github } = setup({ ...base, "apps/old.md": "rename me" });
  repo.branch("pr", "main");
  repo.rename("apps/web/src/main.ts", "docs/main.ts");
  repo.rename("apps/old.md", "apps/new.md");
  const result = before(repo, github(), 7, repo.pushPull(7));
  assert.deepEqual(result, {
    status: 0,
    stdout: "apps/new.md\napps/old.md\napps/web/src/main.ts\n",
    stderr: "",
  });
});

void test("before: a head already in main is refused instead of answering nothing", () => {
  const { repo, github } = setup();
  const head = pr(repo, withCode);
  repo.merge("pr", 7);
  const result = before(repo, github(), 7, head);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /after 7/);
});

void test("before: an unknown head fails instead of printing nothing", () => {
  const { repo, github } = setup();
  pr(repo, withCode);
  const result = before(repo, github(), 7, "1234567890abcdef1234567890abcdef12345678");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

void test("after: a docs-only merge prints nothing", () => {
  const { repo, github } = setup();
  pr(repo, docsOnly);
  const merge = repo.merge("pr", 7);
  const result = after(repo, github({ 7: { mergeCommit: { oid: merge } } }), 7);
  assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
});

void test("after: a merge with code prints its files, and the merge commit on stderr", () => {
  const { repo, github } = setup();
  pr(repo, withCode);
  const merge = repo.merge("pr", 7);
  const result = after(repo, github({ 7: { mergeCommit: { oid: merge } } }), 7);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, withCodeFiles);
  assert.equal(result.stderr, `merge commit ${merge}\n`);
});

void test("after: an unreadable list at the merge commit makes every changed file count", () => {
  const { repo, github } = setup();
  pr(repo, { [workflowPath]: null, "docs/plan.md": "plan 2\n" });
  const merge = repo.merge("pr", 7);
  const result = after(repo, github({ 7: { mergeCommit: { oid: merge } } }), 7);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${workflowPath}\ndocs/plan.md\n`);
  assert.match(result.stderr, /cannot read paths-ignore/);
});

void test("after: the list is the merge commit's, not a later main's", () => {
  const { repo, github } = setup();
  pr(repo, { "docs/plan.md": "plan 2\n" });
  const merge = repo.merge("pr", 7);
  repo.commit({ [workflowPath]: without("docs/**") });
  repo.pushMain();
  const result = after(repo, github({ 7: { mergeCommit: { oid: merge } } }), 7);
  assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
});

void test("after: only the PR's changes count, not main's before the merge", () => {
  const { repo, github } = setup();
  pr(repo, { "docs/plan.md": "plan 2\n" });
  repo.checkout("main");
  repo.commit({ "apps/web/src/main.ts": "changed on main\n" });
  repo.pushMain();
  const merge = repo.merge("pr", 7);
  const result = after(repo, github({ 7: { mergeCommit: { oid: merge } } }), 7);
  assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
});

void test("after: an unmerged PR fails instead of printing nothing", () => {
  const { repo, github } = setup();
  pr(repo, withCode);
  const result = after(repo, github({ 7: { mergeCommit: null } }), 7);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /not merged/);
});

void test("usage errors exit 2 before touching Git or GitHub", () => {
  const { repo, github } = setup();
  const gh = github();
  const head = "1234567890abcdef1234567890abcdef12345678";
  for (const args of [
    [],
    ["before"],
    ["before", "7"],
    ["before", "#7", head],
    ["before", "7", "1234567"],
    ["before", "7", head.toUpperCase()],
    ["before", "7", head, "extra"],
    ["after"],
    ["after", "7", head],
    ["merged", "7"],
  ]) {
    const result = runScript("deploy-files.mjs", args, { cwd: repo.coordinator, env: gh.env });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "", JSON.stringify(args));
  }
  assert.deepEqual(gh.calls(), []);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const repo = "repos/{owner}/{repo}";
const issue = repo + "/issues/3";
const label = "staging を占有中";
const encoded = encodeURIComponent(label);
const add = `api -X POST ${issue}/labels --input -`;
const remove = `api -X DELETE ${issue}/labels/${encoded}`;
const post = `api ${issue}/comments --input -`;
const url = "https://example.org/comments/1";
const deploy = { id: 123, status: "in_progress", html_url: "https://example.org/runs/123" };

function invoke(
  t: TestContext,
  args: string[],
  options: { holders?: number[]; activeDeploy?: boolean; pr?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "staging-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
echo "$*" >> calls
[ "$GH_REPO" = 'wakamenori/instant-madori' ] || exit 1
case "$*" in
  'api ${issue}') echo '${JSON.stringify({ number: 3, pull_request: options.pr ? {} : null })}' ;;
  'api --paginate --slurp ${repo}/issues?labels=${encoded}&state=all&per_page=100')
    echo '${JSON.stringify([[], (options.holders ?? []).map((number) => ({ number }))])}' ;;
  'api --paginate --slurp ${repo}/actions/workflows/deploy-staging.yml/runs?per_page=100')
    echo '${JSON.stringify([{ workflow_runs: [{ ...deploy, status: "completed" }] }, { workflow_runs: options.activeDeploy ? [deploy] : [] }])}' ;;
  '${add}') cat >> calls; echo >> calls; echo '[{"name":"${label}"}]' ;;
  '${remove}') echo '[]' ;;
  '${post}') cat >> calls; echo >> calls; echo '{"html_url":"${url}"}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "staging.ts"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: dir + ":" + process.env.PATH },
  });
  return { ...result, calls: readFileSync(log, "utf8") };
}

void test("start reports all blockers before writing", (t) => {
  for (const options of [
    { holders: [42] },
    { activeDeploy: true },
    { holders: [42, 3], activeDeploy: true },
  ]) {
    const { status, stderr, calls } = invoke(t, ["start", "3"], options);
    assert.equal(status, 1);
    const expected = [];
    if (options.holders)
      expected.push("staging is already occupied by " + (options.activeDeploy ? "#3, #42" : "#42"));
    if (options.activeDeploy)
      expected.push("deploy-staging runs have not finished:", "123 in_progress " + deploy.html_url);
    assert.equal(stderr.trim(), expected.join("\n"));
    assert.doesNotMatch(calls, /-X|--input|\/comments/u);
  }
});

void test("start labels the Issue before announcing the occupation", (t) => {
  const { status, stderr, stdout, calls } = invoke(t, ["start", "3"]);
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), url);
  const writes = calls.trimEnd().split("\n").slice(-4);
  assert.deepEqual(writes.slice(0, 3), [add, JSON.stringify({ labels: [label] }), post]);
  assert.match(writes[3] ?? "", /^\{"body":"指揮役：staging の占有を始めた。/u);
});

void test("end removes the holder's label before announcing the release", (t) => {
  const { status, stderr, stdout, calls } = invoke(t, ["end", "3"], { holders: [3] });
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), url);
  assert.doesNotMatch(calls, /workflows/u);
  assert.deepEqual(calls.trimEnd().split("\n").slice(-3), [
    remove,
    post,
    JSON.stringify({
      body: "指揮役：staging の占有を終えた。ラベル「staging を占有中」を外した。",
    }),
  ]);
});

void test("end rejects a non-holder and names the current holder", (t) => {
  const { status, stderr, calls } = invoke(t, ["end", "3"], { holders: [42] });
  assert.equal(status, 1);
  assert.equal(stderr.trim(), "#3 does not hold the staging occupation (held by #42)");
  assert.doesNotMatch(calls, /workflows|-X|--input|\/comments/u);
});

void test("a pull request cannot hold staging", (t) => {
  const { status, stderr, calls } = invoke(t, ["start", "3"], { pr: true });
  assert.equal(status, 1);
  assert.equal(stderr.trim(), "#3 is a pull request, not an Issue");
  assert.equal(calls.trim(), "api " + issue);
});

void test("invalid commands exit with usage before calling GitHub", (t) => {
  for (const args of [["start", "0"], ["stop", "3"], ["start"]]) {
    const { status, stderr, calls } = invoke(t, args);
    assert.equal(status, 2);
    assert.match(stderr, /Usage:/u);
    assert.equal(calls, "");
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeGitHub, isolatedEnv, runScript, tempDir } from "./testing/support.mjs";

const body = (dependencies, eol = "\n") =>
  [
    "## 目的",
    "",
    "目的。",
    "",
    "## 依存",
    "",
    ...dependencies,
    "",
    "## 人の判断",
    "",
    "なし",
    "",
  ].join(eol);
const reason = "同じ `scripts/check/check.ts` を触るので、順番に流す。";

function run(issue450, args, faults = {}) {
  const home = tempDir();
  const gh = fakeGitHub(
    tempDir(),
    {
      issues: {
        450: { id: 1450, body: issue450.body, blockedBy: issue450.blockedBy ?? [] },
        432: { id: 1432, body: body(["なし"]), blockedBy: [] },
        446: { id: 1446, body: body(["なし"]), blockedBy: [] },
        378: { id: 1378, body: body(["なし"]), blockedBy: [] },
      },
      faults,
    },
    isolatedEnv(home),
  );
  const invoke = () => runScript("blocked-by.mjs", args, { cwd: home, env: gh.env });
  return { result: invoke(), invoke, gh, issue: () => gh.state().issues?.[450] };
}

void test("registers a blocker in GitHub and replaces なし in the 依存 section", () => {
  const { result, issue } = run({ body: body(["なし"]) }, ["450", "446", "--reason", reason]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "#450 blocked by #446\n");
  assert.equal(
    result.stderr,
    "registered #446 as blocking #450 on GitHub\nadded #446 to #450's 依存 section\n",
  );
  assert.deepEqual(issue()?.blockedBy, [446]);
  assert.equal(issue()?.body, body([`- #446。${reason}`]));
});

void test("appends after the existing lines and leaves the rest of the body byte for byte", () => {
  const existing = "- #432。同じ `a.ts` を触るので、順番に流す（#378 の方針）。";
  const { result, issue } = run({ body: body([existing]), blockedBy: [432] }, [
    "450",
    "446",
    "--reason",
    reason,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "#450 blocked by #446\n");
  assert.equal(issue()?.body, body([existing, `- #446。${reason}`]));
});

void test("replaces only the なし line and keeps every other line of the section", () => {
  const comment = "<!-- 先に閉じている必要があるIssue（#番号）。なければ「なし」。 -->";
  for (const [lines, expected] of [
    [
      ["なし", "- #432。同じ表を触る。"],
      ["- #432。同じ表を触る。", `- #446。${reason}`],
    ],
    [
      ["なし", "", "補足：#300 の結論を見てから着手する。"],
      ["", "補足：#300 の結論を見てから着手する。", `- #446。${reason}`],
    ],
    [
      [comment, "", "なし"],
      [comment, `- #446。${reason}`],
    ],
    [
      ["なし。形状サービスのイメージが変わるデプロイの後に行う。"],
      ["なし。形状サービスのイメージが変わるデプロイの後に行う。", `- #446。${reason}`],
    ],
  ]) {
    const { result, issue } = run({ body: body(lines), blockedBy: [432] }, [
      "450",
      "446",
      "--reason",
      reason,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(issue()?.body, body(expected), JSON.stringify(lines));
  }
});

void test("only registers when the 依存 section already lists the blocker", () => {
  const listed = body(["- #432、#446。同じ表を触る。"]);
  const { result, gh, issue } = run({ body: listed, blockedBy: [432] }, ["450", "446"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(issue()?.blockedBy, [432, 446]);
  assert.equal(issue()?.body, listed);
  assert.deepEqual(
    gh.writes().filter((call) => call.argv.includes("PATCH")),
    [],
  );
});

void test("only adds the line when GitHub already has the blocker", () => {
  const { result, gh, issue } = run({ body: body(["なし"]), blockedBy: [446] }, [
    "450",
    "446",
    "--reason",
    reason,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(issue()?.body, body([`- #446。${reason}`]));
  assert.deepEqual(
    gh.writes().filter((call) => call.argv.includes("POST")),
    [],
  );
});

void test("a second run writes nothing and still verifies", () => {
  const first = run({ body: body(["なし"]) }, ["450", "446", "--reason", reason]);
  const settled = first.issue();
  assert.equal(first.result.status, 0, first.result.stderr);
  const initialWrites = first.gh.writes().length;
  const second = first.invoke();
  assert.deepEqual(second, { status: 0, stdout: first.result.stdout, stderr: "" });
  assert.deepEqual(first.gh.writes().slice(initialWrites), []);
  assert.deepEqual(first.issue(), settled);
});

void test("refuses before writing when a missing line has no reason", () => {
  const { result, gh } = run({ body: body(["なし"]) }, ["450", "446"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--reason/);
  assert.deepEqual(gh.writes(), []);
});

void test("fails when the body update does not land (the noclobber incident)", () => {
  const { result } = run({ body: body(["なし"]) }, ["450", "446", "--reason", reason], {
    ignoreBodyWrites: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /#446 is not in #450's 依存/);
});

void test("fails when the GitHub registration does not land", () => {
  const { result } = run({ body: body(["なし"]) }, ["450", "446", "--reason", reason], {
    ignoreRegistrations: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /#446 is not in GitHub's blocked-by of #450/);
});

void test("an issue mentioned inside a reason is not a listed dependency", () => {
  const existing = "- #432。同じ `a.ts` を触るので、順番に流す（#378 の方針）。";
  const { result, issue } = run({ body: body([existing]), blockedBy: [432] }, [
    "450",
    "378",
    "--reason",
    reason,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(issue()?.blockedBy, [432, 378]);
  assert.equal(issue()?.body, body([existing, `- #378。${reason}`]));
});

void test("several missing blockers share one new line", () => {
  const { result, issue } = run({ body: body(["なし"]) }, [
    "450",
    "432",
    "446",
    "--reason",
    reason,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(issue()?.blockedBy, [432, 446]);
  assert.equal(issue()?.body, body([`- #432、#446。${reason}`]));
});

void test("keeps CRLF line endings", () => {
  const { result, issue } = run({ body: body(["なし"], "\r\n") }, [
    "450",
    "446",
    "--reason",
    reason,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(issue()?.body, body([`- #446。${reason}`], "\r\n"));
});

void test("an unknown blocker fails before anything is written", () => {
  const { result, gh } = run({ body: body(["なし"]) }, ["450", "446", "999", "--reason", reason]);
  assert.equal(result.status, 1);
  assert.deepEqual(gh.writes(), []);
});

void test("a body without one 依存 section is refused before anything is written", () => {
  for (const broken of [
    ["## 目的", "", "目的。", ""].join("\n"),
    body(["なし"]) + "\n## 依存\n\nなし\n",
  ]) {
    const { result, gh } = run({ body: broken }, ["450", "446", "--reason", reason]);
    assert.equal(result.status, 1);
    assert.deepEqual(gh.writes(), []);
  }
});

void test("usage errors exit 2 without calling GitHub", () => {
  for (const args of [
    [],
    ["450"],
    ["450", "450"],
    ["450", "446", "446"],
    ["450", "abc"],
    ["#450", "446"],
    ["450", "446", "--reason"],
    ["450", "446", "--reason", ""],
    ["450", "446", "--reason", "two\nlines"],
    ["450", "446", "--reason", "a", "--reason", "b"],
    ["450", "446", "--force"],
  ]) {
    const { result, gh } = run({ body: body(["なし"]) }, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.deepEqual(gh.calls(), [], JSON.stringify(args));
  }
});

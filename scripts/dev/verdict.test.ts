import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  existingComment,
  parseCommand,
  renderComment,
  renderMessage,
  renderStatus,
} from "./verdict.ts";

const head = "1".repeat(40);
const args = ["--pr", "7", "--head", head, "--attempt", "1", "--report", "report.md"];
const decidedAt = "2026-11-22T00:00:00Z";
const pass = { ...parseCommand([...args, "--pass"]), decidedAt };
const fail = { ...parseCommand([...args, "--fail", "地図", "--fail", "検査"]), decidedAt };
const url = "https://example.com/comment";

void test("arguments identify one attempt on one head and a distinct set of failed checks", () => {
  for (const [flag, value] of [
    ["--pr", "0"],
    ["--attempt", "0"],
    ["--head", head.slice(1)],
    ["--head", "A".repeat(40)],
  ] as const) {
    const invalid = [...args, "--pass"];
    invalid[invalid.indexOf(flag) + 1] = value;
    assert.throws(() => parseCommand(invalid));
  }
  for (const flags of [
    [],
    ["--fail"],
    ["--fail", "unknown"],
    ["--fail", "検査", "--fail", "検査"],
    ["--pass", "--fail", "地図"],
  ])
    assert.throws(() => parseCommand([...args, ...flags]));
});

void test("dry run rejects blank and missing reports with a usage error", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "verdict-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "report.md");
  for (const missing of [true, false]) {
    if (!missing) writeFileSync(path, "  \n");
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "verdict.ts"), ...args.slice(0, -1), path, "--pass", "--dry-run"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/u);
    assert.ok(result.stderr.includes(path));
    assert.equal(result.stdout, "");
  }
});

void test("the leading YAML record quotes the SHA and preserves the report", () => {
  const report = "## Commands\n\nTest passed.\n";
  for (const verdict of [pass, fail]) {
    const body = renderComment(verdict, report);
    assert.ok(body.startsWith("```yaml\n"));
    assert.ok(body.includes('head: "' + head + '"\n'));
    const [record, tail] = body.slice(8).split("```\n\n");
    assert.ok(record);
    assert.equal(tail, report);
    assert.deepEqual(parse(record), {
      attempt: 1,
      head,
      verdict: verdict.outcome.verdict,
      decided_at: decidedAt,
      failed_checks: verdict === pass ? [] : ["地図", "検査"],
    });
  }
});

void test("the printed message leads with the verdict record without the attempt", () => {
  const message = renderMessage(fail, url, "failure");
  const [record, tail] = message.slice(8).split("```\n\n");
  assert.ok(record);
  assert.deepEqual(parse(record), {
    head,
    verdict: "FAIL",
    decided_at: decidedAt,
    failed_checks: ["地図", "検査"],
  });
  assert.equal(tail, url + "\nverify failure on " + head);
});

void test("commit status links the verdict to the readable report", () => {
  assert.deepEqual(renderStatus(pass, url), {
    state: "success",
    context: "verify",
    description: "attempt 1: PASS",
    target_url: url,
  });
  assert.deepEqual(renderStatus(fail, url), {
    state: "failure",
    context: "verify",
    description: "attempt 1: FAIL 地図, 検査",
    target_url: url,
  });
});

void test("retries reuse the matching record unless any matching attempt conflicts", () => {
  const body = renderComment(fail, "report");
  const comment = { html_url: url, body };
  for (const other of [
    "text\n" + body,
    body.replace("attempt: 1", "attempt: 2"),
    body.replace(head, "a".repeat(40)),
  ])
    assert.deepEqual(existingComment([{ ...comment, body: other }], fail), { kind: "none" });
  assert.deepEqual(existingComment([comment], { ...fail, decidedAt: "2026-11-23T00:00:00Z" }), {
    kind: "reuse",
    url,
  });
  for (const other of [renderComment(pass, ""), body.replace("地図", "差分")])
    assert.deepEqual(existingComment([comment, { ...comment, body: other }], fail), {
      kind: "conflict",
    });
});

void test("a moved PR head stops before any comment or status is written", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "verdict-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const log = join(dir, "calls.log");
  const report = join(dir, "report.md");
  writeFileSync(report, "report");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\necho "$GH_REPO $*" >> "${log}"\necho '{"headRefOid":"${"b".repeat(40)}"}'\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "verdict.ts"), ...args.slice(0, -1), report, "--pass"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: dir + ":" + process.env.PATH } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from verified head/u);
  assert.equal(
    readFileSync(log, "utf8"),
    "wakamenori/instant-madori pr view 7 --json headRefOid\n",
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { parseCommand, renderStatus } from "./verdict.ts";

void test("Codex runs the silent recorder then the guard for every registered event", () => {
  const cwd = resolve(import.meta.dirname, "../..");
  const command = z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    timeout: z.number(),
  });
  const config = z
    .strictObject({
      hooks: z.record(z.string(), z.array(z.strictObject({ hooks: z.array(command) }))),
    })
    .parse(JSON.parse(readFileSync(resolve(cwd, ".codex/hooks.json"), "utf8")));
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
  ];
  assert.deepEqual(Object.keys(config.hooks).sort(), events.sort());
  for (const [event, groups] of Object.entries(config.hooks)) {
    assert.deepEqual(groups, [
      {
        hooks: [
          {
            type: "command",
            command: `node metrics/hook/codex.ts ${event} >/dev/null 2>&1 || true`,
            timeout: 5,
          },
          { type: "command", command: `node scripts/dev/agent-guard.ts ${event}`, timeout: 30 },
        ],
      },
    ]);
    const guard = groups[0]?.hooks[1];
    assert.ok(guard);
    const run = spawnSync("/bin/sh", ["-c", guard.command], {
      cwd,
      input: JSON.stringify({ hook_event_name: event }),
      encoding: "utf8",
    });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);
  }
});

void test("Claude registers the verifier guard alongside the existing metrics hooks", () => {
  const config = z
    .object({ hooks: z.record(z.string(), z.unknown()) })
    .parse(
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../../.claude/settings.json"), "utf8")),
    );
  const metrics = (args = "") => ({
    type: "command",
    command: `node "$CLAUDE_PROJECT_DIR/metrics/hook/hook.ts"${args} >/dev/null 2>&1 || true`,
    timeout: 5,
  });
  const guard = (event: string) => ({
    type: "command",
    command: `node "$CLAUDE_PROJECT_DIR/scripts/dev/agent-guard.ts" ${event}`,
    timeout: 30,
  });
  assert.deepEqual(config.hooks, {
    SessionStart: [{ hooks: [metrics()] }],
    UserPromptSubmit: [{ hooks: [metrics(), guard("UserPromptSubmit")] }],
    PreToolUse: [{ hooks: [guard("PreToolUse")] }],
    Stop: [{ hooks: [metrics(), guard("Stop")] }],
    PermissionRequest: [{ hooks: [metrics(" permission")] }],
  });
});

void test("Stop checks the verdict for the verifier's session, head and attempt", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "agent-guard-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd }).status, 0);
    const head = "0123456789abcdef0123456789abcdef01234567";
    const args = [
      "--pr",
      "576",
      "--head",
      head,
      "--attempt",
      "1",
      "--pass",
      "--report",
      "report.md",
    ];
    const prompt = "node /main/scripts/dev/verdict.ts " + args.join(" ");
    const status = renderStatus(
      { ...parseCommand(args), decidedAt: "2026-11-23T00:00:00Z" },
      undefined,
    );
    writeFileSync(
      resolve(cwd, "gh"),
      `#!/bin/sh
echo "$*" >> calls
[ "$GH_REPO" = wakamenori/instant-madori ] || exit 1
case "$*" in
  'api --paginate --slurp repos/{owner}/{repo}/commits/${head}/statuses?per_page=100') cat statuses ;;
  'pr view 576 --json headRefOid') cat pr ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const session = { cwd, session_id: "verifier-1" };
    function run(event: string, fields: Record<string, unknown>) {
      const result = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "agent-guard.ts"), event],
        {
          cwd,
          env: { ...process.env, PATH: cwd + delimiter + (process.env.PATH ?? "") },
          input: JSON.stringify({ ...session, ...fields }),
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      return result.stdout;
    }
    const stop = () => run("Stop", {});
    const calls = () => readFileSync(resolve(cwd, "calls"), "utf8");
    const fixture = (name: string, data: unknown) =>
      writeFileSync(resolve(cwd, name), JSON.stringify(data));
    writeFileSync(resolve(cwd, "calls"), "");
    assert.equal(run("UserPromptSubmit", { prompt: "Implement the issue" }), "");
    assert.equal(stop(), "");
    assert.equal(run("UserPromptSubmit", { prompt }), "");
    assert.equal(run("Stop", { stop_hook_active: true }), "");
    assert.equal(run("Stop", { stop_hook_active: false, session_id: "other" }), "");
    assert.equal(calls(), "");

    assert.equal(stop(), ""); // gh exits nonzero while the statuses fixture is missing.
    fixture("statuses", { unexpected: true });
    assert.equal(stop(), "");
    fixture("statuses", [[], [status]]);
    assert.equal(stop(), "");
    assert.doesNotMatch(calls(), /pr view/u);

    fixture("pr", { headRefOid: head });
    fixture("statuses", [[{ ...status, context: "check" }]]);
    function assertBlock(attempt: number) {
      const decision = z
        .object({ decision: z.literal("block"), reason: z.string() })
        .parse(JSON.parse(stop()));
      for (const phrase of [
        "PR #576",
        head,
        `attempt ${attempt}`,
        "--pass",
        "--fail",
        "--report",
      ]) {
        assert.ok(decision.reason.includes(phrase), decision.reason);
      }
    }
    assertBlock(1);
    assert.equal(
      run("UserPromptSubmit", { prompt: prompt.replace("--attempt 1", "--attempt 2") }),
      "",
    );
    assert.equal(run("UserPromptSubmit", { prompt: "Continue" }), "");
    fixture("statuses", [[status]]);
    assertBlock(2);
    fixture("pr", { headRefOid: "f".repeat(40) });
    assert.equal(stop(), "");
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

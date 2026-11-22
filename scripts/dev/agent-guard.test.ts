import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";

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

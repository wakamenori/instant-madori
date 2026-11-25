import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { metricsHome } from "../home.ts";
const root = resolve(import.meta.dirname, "../..");
const settings = z
  .object({
    hooks: z.record(
      z.string(),
      z.array(z.object({ hooks: z.array(z.object({ command: z.string() })) })),
    ),
  })
  .parse(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")));
const recorders = Object.entries(settings.hooks).flatMap(([event, groups]) =>
  groups.flatMap(({ hooks }) =>
    hooks
      .filter(({ command }) => command.includes("metrics/hook/hook.ts"))
      .map(({ command }) => ({ event, command })),
  ),
);
function run(command: string, dir: string, input: object, project = root, path = process.env.PATH) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    env: { CLAUDE_PROJECT_DIR: project, INSTANT_MADORI_METRICS_HOME: dir, PATH: path },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
}
void test("every installed metrics recorder stays silent across opt-in, IO and loader failures", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const home = metricsHome({ INSTANT_MADORI_METRICS_HOME: dir });
  assert.deepEqual(recorders.map(({ event }) => event).sort(), [
    "PermissionRequest",
    "PostToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  for (const { event, command } of recorders) {
    const input = {
      hook_event_name: event,
      tool_name: "Bash",
      tool_response: { backgroundTaskId: "bg", stdout: "private output" },
      tool_input: { command: "private command" },
      permission_suggestions: ["private suggestion"],
    };
    run(command, dir, input);
    mkdirSync(home.ready, { recursive: true });
    run(command, dir, input);
    assert.equal(readdirSync(home.ready).length, 0);
    mkdirSync(home.tmp, { recursive: true });
    run(command, dir, input);
    const [name] = readdirSync(home.ready);
    assert.ok(name);
    assert.equal(statSync(join(home.ready, name)).mode & 0o777, 0o600);
    if (event === "PermissionRequest" || event === "PostToolUse") {
      const stored = readFileSync(join(home.ready, name), "utf8");
      assert.match(stored, /Bash/u);
      assert.doesNotMatch(stored, /private|tool_input|suggestions/u);
    }
    run(command, dir, input, dir);
    run(command, dir, input, root, dir);
    const fake = join(dir, "metrics/hook");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "hook.ts"), 'throw new Error("test failure")');
    run(command, dir, input, dir);
    rmSync(join(dir, "spool"), { recursive: true });
  }
});

void test("background Bash hooks record launch IDs and finish at the output file mtime", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const home = metricsHome({ INSTANT_MADORI_METRICS_HOME: dir });
  mkdirSync(home.ready, { recursive: true });
  mkdirSync(home.tmp, { recursive: true });
  const launch = recorders.find((r) => r.event === "PostToolUse");
  const notification = recorders.find((r) => r.event === "UserPromptSubmit");
  assert.ok(launch && notification);
  const base = {
    hook_event_name: launch.event,
    session_id: "s",
    cwd: dir,
    tool_name: "Bash",
    tool_use_id: "tool_1",
  };
  run(launch.command, dir, { ...base, tool_response: { stdout: "private" } });
  assert.deepEqual(readdirSync(home.ready), []);
  run(launch.command, dir, {
    ...base,
    tool_response: { backgroundTaskId: "bg", stdout: "private" },
  });
  function readInput() {
    const files = readdirSync(home.ready);
    assert.equal(files.length, 1);
    const file = join(home.ready, files[0] ?? "");
    const record = z.object({ stdin: z.string() }).parse(JSON.parse(readFileSync(file, "utf8")));
    rmSync(file);
    return z.record(z.string(), z.json()).parse(JSON.parse(record.stdin));
  }
  assert.deepEqual(readInput(), { ...base, background_task_id: "bg" });
  const path = join(dir, "private.output");
  const end = "2026-11-21T00:00:00.000Z";
  writeFileSync(path, "private output");
  utimesSync(path, new Date(end), new Date(end));
  const prompt = `<task-notification>
<task-id>bg</task-id>
<tool-use-id>tool_1</tool-use-id>
<output-file>${path}</output-file>
<status>completed</status>
<summary>Background command "private" completed (exit code 0)</summary>
</task-notification>`;
  run(notification.command, dir, { hook_event_name: notification.event, prompt });
  assert.deepEqual(readInput().task_notification, {
    task_id: "bg",
    tool_use_id: "tool_1",
    status: "completed",
    exit_code: 0,
    ended_at: end,
  });
});

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
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { metricsHome } from "../home.ts";
void test("every installed settings command stays silent across opt-in, IO and loader failures", (t) => {
  const root = resolve(import.meta.dirname, "../.."),
    dir = mkdtempSync(join(tmpdir(), "hook-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const settings = z
    .object({
      hooks: z.record(
        z.string(),
        z.array(z.object({ hooks: z.array(z.object({ command: z.string() })) })),
      ),
    })
    .parse(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")));
  const home = metricsHome({ INSTANT_MADORI_METRICS_HOME: dir });
  function run(command: string, project = root, path = process.env.PATH) {
    const result = spawnSync("/bin/sh", ["-c", command], {
      env: { CLAUDE_PROJECT_DIR: project, INSTANT_MADORI_METRICS_HOME: dir, PATH: path },
      input: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "private command" },
        permission_suggestions: ["private suggestion"],
      }),
      encoding: "utf8",
    });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
  }
  assert.deepEqual(Object.keys(settings.hooks).sort(), [
    "PermissionRequest",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  for (const list of Object.values(settings.hooks))
    for (const group of list)
      for (const { command } of group.hooks) {
        run(command);
        mkdirSync(home.ready, { recursive: true });
        run(command);
        assert.equal(readdirSync(home.ready).length, 0);
        mkdirSync(home.tmp, { recursive: true });
        run(command);
        const [name] = readdirSync(home.ready);
        assert.ok(name);
        assert.equal(statSync(join(home.ready, name)).mode & 0o777, 0o600);
        if (command.includes(" permission")) {
          const stored = readFileSync(join(home.ready, name), "utf8");
          assert.match(stored, /Bash/u);
          assert.doesNotMatch(stored, /private|tool_input|suggestions/u);
        }
        run(command, dir);
        run(command, root, dir);
        const fake = join(dir, "metrics/hook");
        mkdirSync(fake, { recursive: true });
        writeFileSync(join(fake, "hook.ts"), 'throw new Error("test failure")');
        run(command, dir);
        rmSync(join(dir, "spool"), { recursive: true });
      }
});

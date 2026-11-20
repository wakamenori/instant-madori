import assert from "node:assert/strict";
import { readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runChecks } from "./check.ts";

type Command = string[];
const modes = ["--fast", "default", "--full"] as const;
const eslintFix = (command: Command) => command.includes("eslint") && command.includes("--fix");
const prettierWrite = (command: Command) =>
  command.includes("prettier") && command.includes("--write");
const importBoundaries = (command: Command) => command.includes("scripts/check/check-imports.ts");
const typeCheck = (command: Command) => command.includes("tsc");

const wasmBindingsOnly = mkdtempSync(join(tmpdir(), "madori-check-"));
mkdirSync(join(wasmBindingsOnly, "crates/viewer/pkg"), { recursive: true });
writeFileSync(join(wasmBindingsOnly, "crates/viewer/pkg/madori_viewer.d.ts"), "");
const original = process.cwd();
process.chdir(wasmBindingsOnly);
const resultsDir = join(wasmBindingsOnly, "results");
after(() => {
  process.chdir(original);
  rmSync(wasmBindingsOnly, { recursive: true, force: true });
});

void test("import boundaries read TypeScript after ESLint fixes and formatting, before type checks", async () => {
  for (const mode of modes) {
    const commands: Command[] = [];
    const failure = new Error("step failed");
    await assert.rejects(
      runChecks(
        mode,
        [],
        (_label, command, args) => {
          const invoked = [command, ...args];
          commands.push(invoked);
          return typeCheck(invoked) ? Promise.reject(failure) : Promise.resolve();
        },
        resultsDir,
      ),
      (error) => error === failure,
    );
    const checked = commands.findIndex(importBoundaries);
    const fixed = commands.map(eslintFix).lastIndexOf(true);
    const shown = `${mode}:\n${commands.map((command) => command.join(" ")).join("\n")}`;
    assert(fixed >= 0 && checked > fixed, shown);
    assert(commands.slice(fixed + 1, checked).some(prettierWrite), shown);
  }
});

void test("each mode clears previous results before the first step and records each suite it runs", async () => {
  const e2e = "apps/worker/tests/container.e2e.ts";
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync(e2e, "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  for (const mode of modes) {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "container.jsonl"), "stale");
    const commands = new Map<string, string[]>();
    await runChecks(
      mode,
      [],
      (label, _command, args) => {
        if (!commands.size) assert.deepEqual(readdirSync(resultsDir), []);
        commands.set(label, args);
        return Promise.resolve();
      },
      resultsDir,
    );
    for (const [label, suite] of [
      ["TypeScript tests", "typescript"],
      ["Container integration", "container"],
    ] as const) {
      const args = commands.get(label);
      if (mode === "--fast" || (suite === "container" && mode !== "--full"))
        assert.equal(args, undefined);
      else {
        assert(args);
        assert(args.includes("--test-reporter=spec"));
        assert(args.includes("--test-reporter-destination=stdout"));
        assert(
          args.some(
            (flag) => flag.startsWith("--test-reporter=") && flag.endsWith("/test-results.ts"),
          ),
        );
        assert(args.includes("--test-reporter-destination=" + join(resultsDir, suite + ".jsonl")));
      }
    }
    const rust = commands.get("Rust tests");
    if (mode === "--fast") assert.equal(rust, undefined);
    else {
      assert(rust);
      assert(rust.includes("--no-fail-fast"));
      assert(rust.some((flag) => flag.includes(join(resultsDir, "rust.jsonl"))));
    }
  }
});

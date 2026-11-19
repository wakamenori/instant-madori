import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
after(() => {
  process.chdir(original);
  rmSync(wasmBindingsOnly, { recursive: true, force: true });
});

void test("import boundaries read TypeScript after ESLint fixes and formatting, before type checks", async () => {
  for (const mode of modes) {
    const commands: Command[] = [];
    const failure = new Error("step failed");
    await assert.rejects(
      runChecks(mode, [], (_label, command, args) => {
        const invoked = [command, ...args];
        commands.push(invoked);
        return typeCheck(invoked) ? Promise.reject(failure) : Promise.resolve();
      }),
      (error) => error === failure,
    );
    const checked = commands.findIndex(importBoundaries);
    const fixed = commands.map(eslintFix).lastIndexOf(true);
    const shown = `${mode}:\n${commands.map((command) => command.join(" ")).join("\n")}`;
    assert(fixed >= 0 && checked > fixed, shown);
    assert(commands.slice(fixed + 1, checked).some(prettierWrite), shown);
  }
});

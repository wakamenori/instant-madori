import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";

void test("eslint --fix from the checkout root leaves files in nested agent worktrees untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "madori-eslint-worktrees-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = pathToFileURL(join(import.meta.dirname, "../../eslint.config.mjs"));
  writeFileSync(
    join(root, "eslint.config.mjs"),
    `export { default } from ${JSON.stringify(config.href)};\n`,
  );
  writeFileSync(join(root, "root.mjs"), "export const root = true;\n");

  const worktree = join(root, ".claude/worktrees/agent");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(
    join(worktree, "eslint.config.mjs"),
    'export default [{ rules: { "no-var": "error" } }];\n',
  );
  const agentFile = join(worktree, "agent.mjs");
  const source = Buffer.from("var x = 1;\nexport { x };\n");
  writeFileSync(agentFile, source);

  const eslint = new ESLint({ cwd: root, fix: true });
  const results = await eslint.lintFiles(["."]);
  await ESLint.outputFixes(results);

  assert.deepEqual(results.map(({ filePath }) => relative(root, filePath)).sort(), [
    "eslint.config.mjs",
    "root.mjs",
  ]);
  assert.deepEqual(readFileSync(agentFile), source);
});

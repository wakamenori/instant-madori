import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkSkillArguments } from "./check-skill-arguments.ts";

function repository(t: TestContext, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "madori-skill-arguments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, ".claude/skills", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

void test("reports every placeholder in Markdown prose and code in source order", (t) => {
  const root = repository(t, {
    "x/features/detail.md": "Use $0 here.\n",
    "x/scripts/example.mjs": 'console.log("$1");',
    "x/SKILL.md": [
      "```sh",
      'echo "$1" "$12"',
      'echo "${1}" "$metadata" "$(( (SENT - 60) * 1000 ))" "$(date)"',
      String.raw`sed 's/\(a\)/\1/'`,
      "```",
    ].join("\n"),
  });
  assert.deepEqual(checkSkillArguments(root), {
    files: 2,
    violations: [
      ".claude/skills/x/SKILL.md:2:7: $1 is replaced by a skill argument when the skill is invoked with arguments; put the shell parameter in braces, as in ${1}.",
      ".claude/skills/x/SKILL.md:2:12: $12 is replaced by a skill argument when the skill is invoked with arguments; put the shell parameter in braces, as in ${1}.",
      ".claude/skills/x/features/detail.md:1:5: $0 is replaced by a skill argument when the skill is invoked with arguments; put the shell parameter in braces, as in ${1}.",
    ],
  });
});

void test("reports a missing or empty skills directory", (t) => {
  const root = repository(t);
  const expected = {
    files: 0,
    violations: [".claude/skills has no Markdown files; the check is looking in the wrong place."],
  };
  assert.deepEqual(checkSkillArguments(root), expected);
  mkdirSync(join(root, ".claude/skills"), { recursive: true });
  assert.deepEqual(checkSkillArguments(root), expected);
});

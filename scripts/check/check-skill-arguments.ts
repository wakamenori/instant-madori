import { globSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";

type Placeholder = { file: string; line: number; column: number; written: string };

function markdownFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of globSync(["*", ".*"], { cwd: join(root, directory), withFileTypes: true })) {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(root, path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

export function checkSkillArguments(root: string): { files: number; violations: string[] } {
  const files = markdownFiles(root, ".claude/skills").sort();
  if (files.length === 0) {
    return {
      files: 0,
      violations: [
        ".claude/skills has no Markdown files; the check is looking in the wrong place.",
      ],
    };
  }
  const placeholders: Placeholder[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(/\$\d+/g)) {
        placeholders.push({ file, line: index + 1, column: match.index + 1, written: match[0] });
      }
    }
  }
  const violations = placeholders.map(
    ({ file, line, column, written }) =>
      `${file}:${line}:${column}: ${written} is replaced by a skill argument when the skill is invoked with arguments; put the shell parameter in braces, as in \${1}.`,
  );
  return { files: files.length, violations };
}

if (import.meta.main) {
  const { files, violations } = checkSkillArguments(fileURLToPath(repositoryRoot));
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Skill argument placeholders passed: ${files} Markdown files.`);
  }
}

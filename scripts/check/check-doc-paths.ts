import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";

type PathReference = {
  document: string;
  line: number;
  column: number;
  written: string;
  path: string;
};
type Existence = "present" | "missing" | "not-a-directory" | "outside-repository";

const roots = ["apps/", "crates/", "packages/", "scripts/", "docs/", "third_party/", ".github/"];
const documents = ["README.md", "AGENTS.md", "docs/plan.md"];
const plannedPaths: string[] = [];

function findPathReferences(document: string, markdown: string): PathReference[] {
  const references: PathReference[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const [index, source] of markdown.split(/\r?\n/).entries()) {
    const add = (written: string, column: number, path: string) => {
      references.push({ document, line: index + 1, column: column + 1, written, path });
    };
    const tokens = (text: string, offset: number) => {
      for (const token of text.matchAll(/\S+/g)) {
        const written = token[0];
        if (!roots.some((root) => written.startsWith(root)) || /[<>*?{}[\]]/.test(written))
          continue;
        add(written, offset + token.index, posix.normalize(written.replace(/:\d+(?:-\d+)?$/, "")));
      }
    };
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(source);
    if (fence) {
      if (
        marker &&
        marker[1]?.[0] === fence.character &&
        marker[1].length >= fence.length &&
        source.slice(marker[0].length).trim() === ""
      ) {
        fence = undefined;
      } else {
        tokens(source, 0);
      }
      continue;
    }
    if (marker?.[1]) {
      fence = { character: marker[1][0] ?? "", length: marker[1].length };
      continue;
    }
    let prose = source;
    const runs = [...source.matchAll(/`+/g)];
    for (let i = 0; i < runs.length; i++) {
      const opening = runs[i];
      if (!opening) continue;
      const closingIndex = runs.findIndex((run, j) => j > i && run[0].length === opening[0].length);
      if (closingIndex === -1) continue;
      const closing = runs[closingIndex];
      if (!closing) continue;
      const start = opening.index + opening[0].length;
      tokens(source.slice(start, closing.index), start);
      const end = closing.index + closing[0].length;
      prose = prose.slice(0, opening.index) + " ".repeat(end - opening.index) + prose.slice(end);
      i = closingIndex;
    }
    const links = [...prose.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)/dg)];
    const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/d.exec(prose);
    if (definition) links.push(definition);
    for (const link of links) {
      const written = link[1];
      const position = link.indices?.[1]?.[0];
      if (written === undefined || position === undefined) continue;
      const bare = written.replace(/^<|>$/g, "");
      if (
        !bare ||
        bare.startsWith("#") ||
        bare.startsWith("//") ||
        /^[a-z][a-z\d+.-]*:/i.test(bare)
      )
        continue;
      const target = decodeOrLiteral(bare.split(/[?#]/, 1)[0] ?? "");
      add(
        written,
        position,
        target.startsWith("/")
          ? posix.normalize(target.replace(/^\/+/, "") || ".")
          : posix.normalize(posix.join(posix.dirname(document), target)),
      );
    }
  }
  return references.sort((a, b) => a.line - b.line || a.column - b.column);
}

function decodeOrLiteral(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function resolvePaths(root: string, paths: readonly string[]): Map<string, Existence> {
  const directories = new Map<string, Set<string>>();
  const exists = (path: string): Existence => {
    if (path === ".." || path.startsWith("../")) return "outside-repository";
    let parent = root;
    try {
      for (const segment of path.split("/").filter((part) => part !== "" && part !== ".")) {
        let entries = directories.get(parent);
        if (!entries) {
          entries = new Set(readdirSync(parent));
          directories.set(parent, entries);
        }
        // Directory entries enforce exact case even on case-insensitive file systems.
        if (!entries.has(segment)) return "missing";
        parent = join(parent, segment);
      }
      const stat = statSync(parent);
      return path.endsWith("/") && !stat.isDirectory() ? "not-a-directory" : "present";
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return "missing";
      throw error;
    }
  };
  return new Map(paths.map((path) => [path, exists(path)]));
}

function gitIgnoredPaths(root: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const result = spawnSync(
    "git",
    ["-c", "core.excludesFile=/dev/null", "check-ignore", "--stdin", "-z"],
    {
      cwd: root,
      input: paths.flatMap((path) => [path, `${path}/`]).join("\0") + "\0",
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`git check-ignore failed (${result.status}): ${result.stderr}`);
  const reported = new Set(result.stdout.split("\0"));
  return new Set(paths.filter((path) => reported.has(path) || reported.has(`${path}/`)));
}

export function checkDocumentPaths(
  root: string,
  plannedPaths: readonly string[],
): { references: number; violations: string[] } {
  const references = documents.flatMap((document) =>
    findPathReferences(document, readFileSync(join(root, document), "utf8")),
  );
  const states = resolvePaths(root, [
    ...new Set([...references.map((reference) => reference.path), ...plannedPaths]),
  ]);
  const ignored = gitIgnoredPaths(
    root,
    [...states].filter(([, state]) => state === "missing").map(([path]) => path),
  );
  const messages: Record<Existence, (reference: PathReference) => string | undefined> = {
    present: () => undefined,
    missing: ({ written, path }) =>
      ignored.has(path) || plannedPaths.includes(path)
        ? undefined
        : `${written} does not exist${path === written ? "" : ` (${path})`}.`,
    "not-a-directory": ({ written }) => `${written} is not a directory.`,
    "outside-repository": ({ written }) => `${written} points outside the repository.`,
  };
  const violations: string[] = [];
  for (const reference of references) {
    const state = states.get(reference.path);
    if (!state) continue;
    const message = messages[state](reference);
    if (message)
      violations.push(`${reference.document}:${reference.line}:${reference.column}: ${message}`);
  }
  for (const path of plannedPaths) {
    if (states.get(path) === "present")
      violations.push(
        `scripts/check/check-doc-paths.ts: planned path ${path} exists now; remove it from plannedPaths.`,
      );
    if (!references.some((reference) => reference.path === path))
      violations.push(
        `scripts/check/check-doc-paths.ts: planned path ${path} is not mentioned in README.md, AGENTS.md or docs/plan.md; remove it from plannedPaths.`,
      );
  }
  return { references: references.length, violations };
}

if (import.meta.main) {
  const result = checkDocumentPaths(fileURLToPath(repositoryRoot), plannedPaths);
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Document paths passed: ${result.references} references in ${documents.length} documents.`,
    );
  }
}

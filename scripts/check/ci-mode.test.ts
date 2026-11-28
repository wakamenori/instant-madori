import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";
import { runChecks } from "./check.ts";
import { checkModeFor } from "./ci-mode.ts";

void test("Container, display, dependency, upstream and CI changes need the full check", () => {
  for (const file of [
    "deny.toml",
    ".dockerignore",
    "apps/worker/tests/container.e2e.ts",
    "apps/worker/tests/support/local-worker.ts",
    "apps/worker/tests/support/settle-jobs.ts",
    "scripts/shared/processes.ts",
    "scripts/shared/docker-slots.ts",
    "apps/web/vite.config.ts",
    "apps/web/index.html",
    ".cargo/config.toml",
    "scripts/check/boundaries.ts",
    "scripts/check/check.ts",
    "scripts/check/check-viewer-wasm.ts",
    "scripts/check/check-viewer-wasm-size.ts",
    "scripts/check/check-viewer-wasm-size.json",
    "scripts/check/check-viewer-wasm.test.ts",
    "scripts/check/rust-symbols.ts",
    "scripts/check/rust-symbols.test.ts",
    "apps/geometry/src/main.rs",
    "apps/geometry/Dockerfile",
    "crates/modeling/src/lib.rs",
    "crates/viewer/src/lib.rs",
    "apps/worker/src/geometry/geometry-client.ts",
    "apps/worker/wrangler.jsonc",
    "apps/web/package.json",
    "crates/housing/Cargo.toml",
    "crates/housing/src/lib.rs",
    "pnpm-lock.yaml",
    "third_party/solidcraft/crates/doc/src/lib.rs",
    "third_party/solidcraft/README.md",
    "crates/housing/README.md",
    ".github/workflows/check.yml",
  ]) {
    assert.equal(checkModeFor(["docs/plan.md", file]), "full", file);
  }
});

void test("other service changes use the default check", () => {
  assert.equal(
    checkModeFor([
      "docs/plan.md",
      "apps/worker/src/api/projects.ts",
      "apps/worker/src/storage/d1.ts",
      "apps/web/src/App.tsx",
    ]),
    "default",
  );
  assert.equal(checkModeFor([]), "default");
});

void test("only Markdown changes outside full-check paths use the docs check", () => {
  const files = [
    "docs/plan.md",
    "README.md",
    ".claude/skills/x/SKILL.md",
    ".github/ISSUE_TEMPLATE/bug.md",
    "metrics/README.md",
  ];
  for (const file of files) assert.equal(checkModeFor([file]), "docs", file);
  assert.equal(checkModeFor(files), "docs");
});

void test("job orchestration changes require the real Container path", () => {
  for (const path of [
    "objects/pattern-coordinator.ts",
    "workflows/job-workflow.ts",
    "workflows/job-runs.ts",
    "services/jobs.ts",
    "compose.ts",
  ])
    assert.equal(checkModeFor([`apps/worker/src/${path}`]), "full", path);
});

const root = fileURLToPath(repositoryRoot);
const runtimeImport =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?"(\.{1,2}\/[^"]+)"/gm;
function runtimeImportClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file) || !statSync(join(root, file), { throwIfNoEntry: false })?.isFile())
      continue;
    seen.add(file);
    for (const match of readFileSync(join(root, file), "utf8").matchAll(runtimeImport))
      pending.push(posix.normalize(posix.join(posix.dirname(file), match[1] ?? "")));
  }
  return [...seen].sort();
}

async function scriptsRunBy(mode: "default" | "--full"): Promise<Set<string>> {
  const sandbox = mkdtempSync(join(tmpdir(), "madori-ci-mode-"));
  const original = process.cwd();
  process.chdir(sandbox);
  try {
    mkdirSync("crates/viewer/pkg", { recursive: true });
    writeFileSync("crates/viewer/pkg/madori_viewer.d.ts", "");
    mkdirSync("apps/worker/tests", { recursive: true });
    writeFileSync("apps/worker/tests/container.e2e.ts", "");
    writeFileSync("apps/worker/tests/example.test.ts", "");
    const scripts = new Set<string>();
    await runChecks(
      mode,
      [],
      (_label, _command, args) => {
        for (const arg of args)
          if (
            /\.(?:ts|mjs)$/.test(arg) &&
            statSync(join(root, arg), { throwIfNoEntry: false })?.isFile()
          )
            scripts.add(arg);
        return Promise.resolve();
      },
      { dockerStage: (stage) => stage(), rustStage: () => {} },
      join(sandbox, "results"),
    );
    return scripts;
  } finally {
    process.chdir(original);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

void test("every script only the full check runs, and each module it imports, selects the full check", async () => {
  const always = await scriptsRunBy("default");
  const fullOnly = [...(await scriptsRunBy("--full"))].filter((script) => !always.has(script));
  assert(fullOnly.includes("apps/worker/tests/container.e2e.ts"), fullOnly.join("\n"));
  assert(fullOnly.includes("scripts/check/smoke.ts"), fullOnly.join("\n"));
  const missed = runtimeImportClosure(["scripts/check/check.ts", ...fullOnly]).filter(
    (file) => checkModeFor([file]) !== "full",
  );
  assert.deepEqual(
    missed,
    [],
    "pnpm check --full runs these files but CI would pick the default check for a change to them. Add them to fullCheckPrefixes in scripts/check/ci-mode.ts",
  );
});

const cli = fileURLToPath(new URL("./ci-mode.ts", import.meta.url));

function cliFlag(paths: string | Buffer) {
  const result = spawnSync(process.execPath, [cli], { input: paths, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

void test("the CLI prints the flag for NUL-separated paths", () => {
  for (const [file, expected] of [
    ["deny.toml", "--full"],
    ["apps/worker/tests/support/settle-jobs.ts", "--full"],
    ["docs/plan.md", "--docs"],
    ["apps/web/src/App.tsx", ""],
  ] as const) {
    assert.equal(cliFlag(file + "\0"), expected, file);
  }
  assert.equal(cliFlag("README.md\0deny.toml\0"), "--full");
});

void test("the workflow diff keeps both sides of renames and preserves tabs in full-check paths", (t) => {
  const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");
  const diff = workflow.match(
    /git diff (.+) "\$BASE\.\.\.HEAD" \| node scripts\/check\/ci-mode\.ts/,
  );
  assert(diff?.[1], "The mode step should pipe changed paths into ci-mode.ts");
  const gitDiffArgs = diff[1].split(" ");
  const directory = mkdtempSync(join(tmpdir(), "madori-mode-diff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: directory },
    );
  git("init", "-q");
  writeFileSync(join(directory, "example.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  git("mv", "example.ts", "example.md");
  git("commit", "-qm", "rename");
  assert.equal(cliFlag(git("diff", ...gitDiffArgs, "HEAD~1...HEAD")), "");

  mkdirSync(join(directory, "apps/geometry"), { recursive: true });
  writeFileSync(join(directory, "apps/geometry/name\twith-tab.md"), "");
  git("add", ".");
  git("commit", "-qm", "add geometry document");
  assert.equal(cliFlag(git("diff", ...gitDiffArgs, "HEAD~1...HEAD")), "--full");
});

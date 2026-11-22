import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isRustInput, rustSkipBase } from "./rust-inputs.ts";

void test("Rust source, fixtures, tooling and generated contracts are Rust inputs", () => {
  for (const path of [
    "crates/display/tests/data",
    "apps/geometry/src/main.rs",
    "third_party/solidcraft/fixture",
    "packages/contracts/src/generated/display.ts",
    "nested/Cargo.toml",
    "Cargo.lock",
    "nested/.cargo/config",
    "rust-toolchain.toml",
    ".rustfmt.toml",
    "clippy.toml",
    "deny.toml",
    "mise.toml",
    "scripts/check/check.ts",
    "scripts/check/test-results.ts",
    "scripts/shared/repository.ts",
    "scripts/generate/geometry-schema.test.ts",
    "pnpm-lock.yaml",
  ])
    assert(isRustInput(path), path);
  for (const path of ["apps/web/src/index.ts", "README.md", "mycrates/file"])
    assert(!isRustInput(path), path);
});

void test("each Git change layer can require Rust independently", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "madori-rust-inputs-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const write = (file: string, content: string) => writeFileSync(join(cwd, file), content);
  const base = () => rustSkipBase(cwd, false, undefined);
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  write(".gitignore", "ignored.rs\n");
  write("a.rs", "original");
  git("add", ".");
  git("commit", "-qm", "initial");
  assert.equal(base(), undefined);
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  write("ui.ts", "changed");
  write("ignored.rs", "ignored");
  assert.equal(base(), sha);
  assert.equal(rustSkipBase(cwd, true, undefined), undefined);
  assert.equal(rustSkipBase(cwd, false, ""), undefined);
  write("untracked\nfile.rs", "new");
  assert.equal(base(), undefined);
  rmSync(join(cwd, "untracked\nfile.rs"));
  write("a.rs", "staged");
  assert.equal(base(), undefined);
  git("add", "a.rs");
  write("a.rs", "original");
  assert.equal(base(), undefined);
  git("commit", "-qm", "staged Rust change");
  assert.equal(base(), undefined);
  git("mv", "a.rs", "renamed.txt");
  git("commit", "-qam", "move Rust input");
  assert.equal(base(), undefined);
});

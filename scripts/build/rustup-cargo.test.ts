import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";

const script = fileURLToPath(new URL("./rustup-cargo.ts", import.meta.url));

function executable(path: string, mode = 0o755) {
  writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode });
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rustup-cargo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = join(root, "r");
  const h = join(root, "h");
  mkdirSync(r);
  mkdirSync(h);
  executable(join(r, "rustup"));
  return { r, h };
}

function check(...directories: string[]) {
  return spawnSync(process.execPath, [script], {
    env: { PATH: directories.join(":") },
    encoding: "utf8",
  });
}

void test("accepts a symlink to rustup", (t) => {
  const { r } = fixture(t);
  symlinkSync("rustup", join(r, "cargo"));
  const result = check(r);
  assert.equal(result.status, 0);
  assert(result.stdout.includes(join(r, "cargo")));
});

void test("accepts a hard link to rustup", (t) => {
  const { r } = fixture(t);
  linkSync(join(r, "rustup"), join(r, "cargo"));
  assert.equal(check(r).status, 0);
});

void test("reports the first executable cargo even when a proxy appears later", (t) => {
  const { h, r } = fixture(t);
  executable(join(h, "cargo"));
  symlinkSync("rustup", join(r, "cargo"));
  const result = check(h, r);
  assert.equal(result.status, 1);
  for (const text of [
    join(h, "cargo"),
    "not a rustup proxy",
    "mise exec -- pnpm setup",
    `before ${h}`,
  ]) {
    assert(result.stderr.includes(text), result.stderr);
  }
});

void test("rejects cargo beside an unrelated rustup executable", (t) => {
  const { h } = fixture(t);
  executable(join(h, "cargo"));
  executable(join(h, "rustup"));
  assert.equal(check(h).status, 1);
});

void test("skips cargo without execute permission", (t) => {
  const { h, r } = fixture(t);
  executable(join(h, "cargo"), 0o644);
  symlinkSync("rustup", join(r, "cargo"));
  const result = check(h, r);
  assert.equal(result.status, 0);
  assert(result.stdout.includes(join(r, "cargo")));
});

void test("reports a missing cargo", (t) => {
  const { h } = fixture(t);
  const result = check(h);
  assert.equal(result.status, 1);
  assert(result.stderr.includes("cargo is not on PATH"));
});

// prepare-checkout runs `cargo metadata`, so the check must precede every step after the tools.
void test("setup checks for the rustup proxy right after installing the tools", () => {
  const { scripts } = z
    .object({ scripts: z.object({ setup: z.string() }) })
    .parse(JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")));
  assert.deepEqual(scripts.setup.split(" && ").slice(0, 2), [
    "mise install",
    "node scripts/build/rustup-cargo.ts",
  ]);
});

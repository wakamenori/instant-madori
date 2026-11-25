import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  cargoTestFlags,
  nodeTestFlags,
  parseLibtest,
  readArtifact,
  rustBinaryId,
} from "./test-results.ts";

async function temporary(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "madori-results-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t: TestContext, source: string, exit: number) {
  const cwd = await temporary(t);
  const dir = join(cwd, "results");
  await mkdir(dir);
  await writeFile(join(cwd, "fixture.mjs"), source);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [...nodeTestFlags(dir, "typescript"), "fixture.mjs"], {
    cwd,
    env,
    encoding: "utf8",
  });
  assert.equal(run.status, exit, run.stderr + run.stdout);
  return Object.fromEntries((await readArtifact(dir)).map((r) => [r.id, r.outcome]));
}

void test("reporter separates nested results, duplicates, skipped tests and own failures", async (t) => {
  for (const broken of [true, false]) {
    const results = await fixture(
      t,
      `
      import {describe,it,after} from 'node:test';
      describe('suite',()=>{describe('inner',()=>{
        it('repeat',()=>{});
        it.skip('repeat',()=>{});
        it.todo('repeat');
        it('bad',()=>{throw Error()});
      }); after(()=>{if(${String(broken)})throw Error()});});
    `,
      1,
    );
    assert.deepEqual(results, {
      "fixture.mjs": "pass",
      "fixture.mjs > suite": broken ? "fail" : "pass",
      "fixture.mjs > suite > inner": "pass",
      "fixture.mjs > suite > inner > repeat": "pass",
      "fixture.mjs > suite > inner > repeat #2": "skip",
      "fixture.mjs > suite > inner > repeat #3": "skip",
      "fixture.mjs > suite > inner > bad": "fail",
    });
  }
});
void test("late children after a timeout have no independent result", async (t) => {
  const results = await fixture(
    t,
    `
    import {test} from 'node:test';
    import {setTimeout as sleep} from 'node:timers/promises';
    test('parent',{timeout:30},async t=>{
      await t.test('slow',()=>sleep(150));
      await t.test('late',()=>{});
    });`,
    1,
  );
  assert.deepEqual(results, {
    "fixture.mjs": "pass",
    "fixture.mjs > parent": "fail",
    "fixture.mjs > parent > slow": "skip",
  });
});
void test("reporter records load crashes and successful files", async (t) => {
  assert.deepEqual(await fixture(t, "throw Error('load')", 1), { "fixture.mjs": "fail" });
  assert.deepEqual(
    await fixture(t, "import {test} from 'node:test';test('fixture.mjs',()=>{})", 0),
    {
      "fixture.mjs": "pass",
      "fixture.mjs > fixture.mjs": "pass",
    },
  );
});
void test("cargo records same-named library, binary and integration tests separately", async (t) => {
  const cwd = await temporary(t);
  const dir = join(cwd, "results");
  await mkdir(dir);
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "tests"));
  await copyFile(
    new URL("../../rust-toolchain.toml", import.meta.url),
    join(cwd, "rust-toolchain.toml"),
  );
  await writeFile(
    join(cwd, "Cargo.toml"),
    '[workspace]\n[package]\nname = "same-name"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  await writeFile(
    join(cwd, "Cargo.lock"),
    'version = 4\n[[package]]\nname = "same-name"\nversion = "0.1.0"\n',
  );
  await writeFile(join(cwd, "src/lib.rs"), "#[test] fn library() {}");
  await writeFile(join(cwd, "src/main.rs"), "fn main() {}\n#[test] fn binary() {}");
  await writeFile(join(cwd, "tests/same_name.rs"), "#[test] fn integration() {}");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.CARGO_TARGET_DIR = join(cwd, "target");
  const run = spawnSync("cargo", cargoTestFlags(dir, cwd), { cwd, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(Object.fromEntries((await readArtifact(dir)).map((r) => [r.id, r.outcome])), {
    "same-name/src/lib.rs": "pass",
    "same-name/src/lib.rs::library": "pass",
    "same-name/src/main.rs": "pass",
    "same-name/src/main.rs::binary": "pass",
    "same-name/tests/same_name.rs": "pass",
    "same-name/tests/same_name.rs::integration": "pass",
  });
});
void test("Rust binary ids use the executable rule's first prerequisite with spaces", () => {
  const exe = "/ws/build dir/test";
  const rule = String.raw`/ws/build\ dir/test: crates/my\ pkg/tests/a\ b.rs crates/my\ pkg/src/other.rs`;
  const depInfo = exe + ".d: other.rs\n" + rule;
  assert.equal(rustBinaryId(depInfo, exe, "/ws", "/ws/crates/my pkg", "pkg"), "pkg/tests/a b.rs");
  assert.throws(
    () => rustBinaryId(exe + ".d: other.rs", exe, "/ws", "/ws/crates/my pkg", "pkg"),
    /Missing crate root for executable/u,
  );
});
void test("libtest counts individual tests and distinguishes a failed process", () => {
  const output = `running 3 tests
test a::one ... ok
test b ... ignored, needs a server
test c ... FAILED

failures:

---- c stdout ----
test fake ... ok

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
  const binary = "pkg/example";
  assert.deepEqual(parseLibtest(binary, output, 101), [
    { id: binary + "::a::one", outcome: "pass" },
    { id: binary + "::b", outcome: "skip" },
    { id: binary + "::c", outcome: "fail" },
    { id: binary, outcome: "pass" },
  ]);
  assert.throws(
    () => parseLibtest(binary, output.replace("1 passed", "2 passed"), 101),
    /summary mismatch/u,
  );
  assert.deepEqual(parseLibtest(binary, "running 3 tests\n", null), [
    { id: binary, outcome: "fail" },
  ]);
  assert.deepEqual(parseLibtest(binary, "test result: ok. 0 passed; 0 failed; 0 ignored;", 1), [
    { id: binary, outcome: "fail" },
  ]);
});
void test("reader rejects malformed, duplicate, oversized and unknown artifact entries", async (t) => {
  const dir = await temporary(t);
  const path = join(dir, "typescript.jsonl");
  const valid = JSON.stringify({ id: "x", outcome: "pass" });
  for (const invalid of [
    "no json",
    '{"id":"x","outcome":"unknown"}',
    valid + "\n" + valid,
    valid + "\n\n",
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(readArtifact(dir));
  }
  await truncate(path, 5 * 1024 * 1024 + 1);
  await assert.rejects(readArtifact(dir), /Oversized/u);
  await rm(path);
  await mkdir(join(dir, "unexpected"));
  await assert.rejects(readArtifact(dir), /Unexpected/u);
});

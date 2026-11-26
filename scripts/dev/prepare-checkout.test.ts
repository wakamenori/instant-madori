import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { findCheckout, prepareCheckout } from "./prepare-checkout.ts";

function fixture(t: TestContext) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "prepare-checkout-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const main = join(parent, "main");
  const root = join(parent, "linked");
  mkdirSync(main);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: main,
    });
  git("init", "--quiet");
  mkdirSync(join(main, "pkg/src"), { recursive: true });
  writeFileSync(join(main, "pkg/src/lib.rs"), "");
  git("add", "pkg");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  git("worktree", "add", "--quiet", "--detach", root);
  mkdirSync(join(main, "target/x"), { recursive: true });
  writeFileSync(join(main, "target/x/y.txt"), "cached");
  mkdirSync(join(main, ".tools/bin"), { recursive: true });
  writeFileSync(join(main, ".tools/bin/tool"), "tool");
  const source = join(root, "pkg/src/lib.rs");
  const old = new Date("2000-01-01T00:00:00Z");
  utimesSync(source, old, old);
  const hooks: string[] = [];
  const prepare = (cwd: string, mbx = false) =>
    prepareCheckout(findCheckout(cwd), {
      mbx,
      localPackageDirs: (checkout) => [join(checkout, "pkg")],
      installHooks: (checkout) => hooks.push(checkout),
    });
  return { main, root, source, old, hooks, prepare };
}

void test("main installs shared hooks and leaves the linked checkout alone", (t) => {
  const f = fixture(t);
  f.prepare(f.main);
  assert.deepEqual(f.hooks, [f.main]);
  assert(!existsSync(join(f.root, "target")));
  assert(!existsSync(join(f.root, ".tools")));
});

void test("linked checkout clones both caches and refreshes tracked local sources", (t) => {
  const f = fixture(t);
  const start = Date.now();
  f.prepare(f.root);
  assert.deepEqual(f.hooks, []);
  for (const path of ["target/x/y.txt", ".tools/bin/tool"]) {
    assert.deepEqual(readFileSync(join(f.root, path)), readFileSync(join(f.main, path)));
  }
  const mtime = statSync(f.source).mtimeMs;
  assert(mtime >= start - 1 && mtime <= Date.now() + 1);
});

void test("refuses to clone a target across filesystems without leaving a destination", (t) => {
  const f = fixture(t);
  const target = join(f.main, "target");
  rmSync(target, { recursive: true });
  symlinkSync("/dev", target);
  assert.throws(() => f.prepare(f.root), /across filesystems/u);
  assert.equal(lstatSync(join(f.root, "target"), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(
    readdirSync(f.root).filter((name) => name.startsWith("target.clone-")),
    [],
  );
});

void test("refreshes local sources after the clone lands", (t) => {
  const f = fixture(t);
  f.prepare(f.root);
  const sourceTime = statSync(f.source).mtimeMs;
  const files = readdirSync(join(f.root, "target"), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile());
  assert(files.length > 0);
  for (const file of files) {
    const path = join(file.parentPath, file.name);
    // A clone preserves mtime, but each new inode receives its own ctime.
    assert(sourceTime >= statSync(path).ctimeMs, `source must be refreshed after cloning ${path}`);
  }
});

void test("the clone keeps cached file mtimes", (t) => {
  const f = fixture(t);
  const cached = "target/x/y.txt";
  utimesSync(join(f.main, cached), f.old, f.old);
  f.prepare(f.root);
  assert.equal(statSync(join(f.root, cached)).mtimeMs, statSync(join(f.main, cached)).mtimeMs);
});

void test("replaces a shared target symlink while preserving its source", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.main, "target"), join(f.root, "target"));
  f.prepare(f.root);
  assert(lstatSync(join(f.root, "target")).isDirectory());
  assert.equal(readFileSync(join(f.root, "target/x/y.txt"), "utf8"), "cached");
  assert.equal(readFileSync(join(f.main, "target/x/y.txt"), "utf8"), "cached");
});

void test("an existing target skips cloning and source refresh", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "target"));
  f.prepare(f.root);
  assert(!existsSync(join(f.root, "target/x")));
  assert.equal(statSync(f.source).mtimeMs, f.old.getTime());
});

void test("an absent main target leaves the linked target absent", (t) => {
  const f = fixture(t);
  rmSync(join(f.main, "target"), { recursive: true });
  f.prepare(f.root);
  assert(!existsSync(join(f.root, "target")));
  assert.equal(statSync(f.source).mtimeMs, f.old.getTime());
  assert.equal(readFileSync(join(f.root, ".tools/bin/tool"), "utf8"), "tool");
});

void test("mbx clones tools and removes a shared target link without touching sources", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.main, "target"), join(f.root, "target"));
  f.prepare(f.root, true);
  assert(!lstatSync(join(f.root, "target"), { throwIfNoEntry: false }));
  assert.equal(statSync(f.source).mtimeMs, f.old.getTime());
  assert.equal(readFileSync(join(f.root, ".tools/bin/tool"), "utf8"), "tool");
  assert.equal(readFileSync(join(f.main, "target/x/y.txt"), "utf8"), "cached");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { checkUpstream } from "./check-layout.ts";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), "madori-upstream-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.filemode=true",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8" },
    ).trim();
  const subtree = "third_party/solidcraft";
  const root = pathToFileURL(directory + sep);
  const path = (name: string) => join(directory, subtree, name);
  const cache = join(directory, "node_modules/.cache/upstream-blobs.json");
  git("init", "-q");
  fs.mkdirSync(path(""), { recursive: true });
  fs.writeFileSync(path("a.txt"), "hello\n");
  fs.writeFileSync(path("b.txt"), "world\r\n");
  fs.writeFileSync(path("run"), "hello\n");
  fs.chmodSync(path("run"), 0o755);
  git("add", ".");
  git("commit", "-qm", "checkout");
  const commit = git("commit-tree", git("rev-parse", "HEAD:" + subtree), "-m", "upstream pin");
  return {
    git,
    directory,
    path,
    cache,
    check: (localPatches: string[] = []) => checkUpstream(root, { commit, localPatches }, cache),
  };
}

void test("accepts an unchanged checkout and a recorded patch", (t) => {
  const repo = fixture(t);
  assert.equal(repo.check(), 3);
  fs.writeFileSync(repo.path("a.txt"), "patched\n");
  assert.equal(repo.check(["a.txt"]), 2);
});

void test("rejects edited bytes and reports files deleted from disk", (t) => {
  const repo = fixture(t);
  fs.writeFileSync(repo.path("a.txt"), "unrecorded\n");
  assert.throws(() => repo.check(), { message: "Unrecorded upstream change: a.txt" });
  fs.unlinkSync(repo.path("a.txt"));
  assert.throws(() => repo.check(["a.txt"]), { code: "ENOENT", path: repo.path("a.txt") });
});

void test("rejects a same-size edit even with its mtime restored", (t) => {
  const repo = fixture(t);
  const path = repo.path("a.txt");
  fs.utimesSync(path, 1, 1);
  const clock = t.mock.method(Date, "now", () => new Date().getTime() + 3000);
  assert.equal(repo.check(), 3);
  clock.mock.restore();
  fs.writeFileSync(path, "other\n");
  fs.utimesSync(path, 1, 1);
  assert.throws(() => repo.check(), { message: "Unrecorded upstream change: a.txt" });
});

void test("rejects CRLF on disk even when the index holds the pinned LF blob", (t) => {
  const repo = fixture(t);
  const path = "third_party/solidcraft/a.txt";
  fs.writeFileSync(repo.path(".gitattributes"), "a.txt text eol=lf\n");
  fs.writeFileSync(repo.path("a.txt"), "hello\r\n");
  repo.git("add", path);
  assert.equal(repo.git("rev-parse", ":" + path), repo.git("rev-parse", "HEAD:" + path));
  assert.throws(() => repo.check([".gitattributes"]), {
    message: "Unrecorded upstream change: a.txt",
  });
});

void test("accepts pinned bytes on disk even after info/attributes changes the staged blob", (t) => {
  const repo = fixture(t);
  const path = "third_party/solidcraft/b.txt";
  fs.writeFileSync(join(repo.directory, ".git/info/attributes"), "/" + path + " text eol=lf\n");
  repo.git("add", "--renormalize", path);
  assert.notEqual(repo.git("rev-parse", ":" + path), repo.git("rev-parse", "HEAD:" + path));
  assert.equal(repo.check(), 3);
});

void test("rejects untracked additions and accepts files removed only from the index", (t) => {
  const repo = fixture(t);
  repo.git("rm", "--cached", "-q", "third_party/solidcraft/a.txt");
  assert.equal(repo.check(), 3);
  fs.writeFileSync(repo.path("extra"), "");
  assert.throws(() => repo.check(), { message: "Unrecorded upstream addition: extra" });
  assert.equal(repo.check(["extra"]), 3);
});

void test("rejects a symlink replacing a regular file with the same blob bytes", (t) => {
  const repo = fixture(t);
  fs.unlinkSync(repo.path("a.txt"));
  fs.symlinkSync("hello\n", repo.path("a.txt"));
  assert.throws(() => repo.check(), { message: "Changed file kind: a.txt" });
});

void test("preserves executable permission rules", { skip: process.platform === "win32" }, (t) => {
  const repo = fixture(t);
  fs.chmodSync(repo.path("a.txt"), 0o755);
  fs.chmodSync(repo.path("run"), 0o654);
  assert.equal(repo.check(), 3);
  fs.chmodSync(repo.path("run"), 0o644);
  assert.throws(() => repo.check(), { message: "Lost executable permission: run" });
});

void test("uses cached blobs for unchanged files and reads edited files again", (t) => {
  const repo = fixture(t);
  const clock = t.mock.method(Date, "now", () => new Date().getTime() + 3000);
  assert.equal(repo.check(), 3);
  clock.mock.restore();
  fs.writeFileSync(repo.path("b.txt"), "other\r\n");

  const read = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  try {
    assert.throws(() => repo.check(), { message: "Unrecorded upstream change: b.txt" });
    const reads = read.mock.calls.map(({ arguments: [path] }) => path);
    assert(reads.includes(repo.path("b.txt")));
    assert(!reads.includes(repo.path("a.txt")));
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("rebuilds an invalid cache and leaves recent entries out", (t) => {
  const repo = fixture(t);
  fs.mkdirSync(join(repo.directory, "node_modules/.cache"), { recursive: true });
  fs.writeFileSync(repo.cache, '{"a.txt":{"stat":"invalid","oid":"invalid"}}');
  const clock = t.mock.method(Date, "now", () => new Date().getTime() - 3000);
  assert.equal(repo.check(), 3);
  clock.mock.restore();
  assert.equal(fs.readFileSync(repo.cache, "utf8"), "{}");
});

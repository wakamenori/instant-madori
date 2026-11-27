import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { tryLock } from "../shared/docker-slots.ts";
import { entryHolders } from "./remove-target.ts";

const check = "scripts/check/check.ts";
const dev = "scripts/dev/dev.ts";
void test("only node's entry script in the selected worktree holds target", () => {
  const root = "/x/work tree";
  const sibling = root + "-next";
  const cases = [
    ["nvim", dev, root, undefined],
    ["node", check + " --rust", root, check],
    ["node", "../" + check, root + "/apps", check],
    ["node", "--inspect-brk=127.0.0.1:0 " + join(root, check), sibling, check],
    ["node", "./" + dev, root, dev],
    ["node", "-r setup --loader tsx --env-file=.env -C test " + dev, root, dev],
    ["node", join(sibling, check), root, undefined],
    ["node", check, sibling, undefined],
    ["node", "metrics/hook/run-span.ts check -- node " + check, root, undefined],
    ["node", '-e "test" ' + check, root, undefined],
    ["node", "/some/mcp/server.js", root, undefined],
  ] as const;
  for (const [executable, tail, cwd, script] of cases) {
    const row = { pid: 12, executable: "/bin/" + executable, args: executable + " " + tail, cwd };
    assert.deepEqual(
      entryHolders([row], root, 99),
      script ? [{ kind: "entry", pid: 12, script }] : [],
      row.args,
    );
    assert.deepEqual(entryHolders([row], root, 12), []);
  }
});

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "remove-target-")));
  t.after(() => rmSync(base, { recursive: true }));
  const root = join(base, "work tree");
  const sibling = root + "-next";
  const target = join(root, "target");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(root, ".gitignore"), "/target\n");
  for (const entry of [check, dev]) {
    mkdirSync(join(root, entry, ".."), { recursive: true });
    writeFileSync(join(root, entry), 'console.log("ready"); setInterval(() => {}, 60000);\n');
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  git("worktree", "add", "-b", "next", sibling);
  mkdirSync(target);
  function run() {
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./remove-target.ts", import.meta.url))],
      { cwd: root, encoding: "utf8" },
    );
  }
  return { root, sibling, target, git, run };
}

async function start(t: TestContext, cwd: string, executable: string, args: string[]) {
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
  t.after(async () => {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  await once(child.stdout, "data");
  return child.pid;
}
const mac = { skip: process.platform !== "darwin" };
void test("editor, resident node and sibling check leave target idle", mac, async (t) => {
  const { root, sibling, target, run } = fixture(t);
  await start(t, root, "tail", ["-f", dev]);
  await start(t, root, process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},60000)']);
  await start(t, sibling, process.execPath, [check]);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed target\/: free \d+\.\d GiB -> \d+\.\d GiB\n$/u);
  assert.equal(existsSync(target), false);
});

void test("all check, dev and Cargo lock holders are reported", mac, async (t) => {
  const { root, target, run } = fixture(t);
  const locks = ["debug/.cargo-lock", "triple/debug/.cargo-build-lock"];
  for (const lock of locks) {
    mkdirSync(join(target, lock, ".."), { recursive: true });
    const fd = tryLock(join(target, lock));
    assert.ok(fd !== undefined);
    t.after(() => closeSync(fd));
  }
  const checkPid = await start(t, root, process.execPath, [check]);
  const devPid = await start(t, root, process.execPath, [dev]);
  const result = run();
  assert.equal(result.status, 1);
  for (const line of [
    `entry ${checkPid} ${check}`,
    `entry ${devPid} ${dev}`,
    ...locks.map((lock) => "cargo-lock " + join(target, lock)),
  ]) {
    assert.ok(result.stderr.split("\n").includes(line), result.stderr);
  }
  assert.ok(existsSync(target));
});

void test("tracked, unignored, symlink and missing targets", mac, (t) => {
  const { root, target, git, run } = fixture(t);
  writeFileSync(join(target, "tracked"), "");
  git("add", "-f", "target/tracked");
  writeFileSync(join(root, ".gitignore"), "");
  const tracked = run();
  assert.equal(tracked.status, 1);
  assert.match(tracked.stderr, /git .*tracked/u);
  assert.match(tracked.stderr, /git .*ignored/u);
  assert.ok(existsSync(join(target, "tracked")));
  rmSync(target, { recursive: true });
  symlinkSync(root, target);
  const symlink = run();
  assert.equal(symlink.status, 1);
  assert.match(symlink.stderr, /not-directory/u);
  assert.ok(existsSync(target));
  rmSync(target);
  const missing = run();
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.trim(), "no target/");
});

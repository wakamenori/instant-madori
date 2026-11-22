import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { git, isolatedEnv, repository, runScript, tempDir } from "./testing/support.mjs";

function setup() {
  const home = tempDir();
  const env = isolatedEnv(home);
  const repo = repository({ tracked: "base", ".gitignore": "target/\n" }, env);
  const main = repo.coordinator;
  const cmd = (path, ...args) => git(path, env, ...args);
  function add(path, ...args) {
    cmd(main, "worktree", "add", ...args, path, "origin/main");
    return path;
  }
  const agent = (id) =>
    add(join(main, ".claude/worktrees", "agent-" + id), "-b", "worktree-agent-" + id);
  const t3 = (id, ...args) => add(join(home, ".t3/worktrees/instant-madori", id), ...args);
  const run = (args, cwd = main) => runScript("worktrees.mjs", args, { cwd, env });
  function aged(path, hours) {
    const admin = cmd(path, "rev-parse", "--path-format=absolute", "--git-dir");
    const date = new Date(Date.now() - hours * 3600000);
    utimesSync(join(admin, "commondir"), date, date);
    return path;
  }
  const lock = (path, reason) => cmd(main, "worktree", "lock", "--reason", reason, path);
  const branches = () => cmd(main, "branch", "--format=%(refname:short)").split("\n");
  return { repo, main, env, cmd, add, agent, t3, run, aged, lock, branches };
}

function lockReason(path, pid) {
  return `claude agent ${basename(path)} (pid ${pid} start Sun Nov 22 08:30:29 2026)`;
}

function livePid(t) {
  const child = spawn("/bin/sleep", ["600"]);
  t.after(() => child.kill());
  return child.pid;
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid;
}

function success(stdout, stderr = "") {
  return { status: 0, stdout, stderr };
}

for (const owner of [false, true]) {
  test(`agent discards dirty files and deletes its branch from ${owner ? "an older linked checkout" : "main"}`, () => {
    const f = setup();
    const cwd = owner ? f.t3("owner", "--detach") : f.main;
    f.repo.commit({ tracked: "new" });
    f.repo.pushMain();
    f.cmd(f.main, "fetch", "origin");
    const path = f.agent("x");
    writeFileSync(join(path, "tracked"), "changed");
    writeFileSync(join(path, "extra"), "");
    assert.deepEqual(
      f.run(["agent", path], cwd),
      success(`removed ${path}\n`, `discard ${path}:  M tracked\ndiscard ${path}: ?? extra\n`),
    );
    assert(!existsSync(path));
    assert(!f.branches().includes("worktree-agent-x"));
  });
}

test("agent recognizes detached and switched worktrees and preserves other branches", () => {
  const f = setup();
  for (const id of ["detached", "switched"]) {
    const path = f.agent(id);
    f.cmd(path, "checkout", ...(id === "detached" ? ["--detach"] : ["-b", "mine"]));
    assert.deepEqual(f.run(["agent", path]), success(`removed ${path}\n`));
    assert(!existsSync(path));
    assert(!f.branches().includes("worktree-agent-" + id));
  }
  assert(f.branches().includes("mine"));
});

test("agent respects live and foreign locks and removes stale locks", (t) => {
  const f = setup();
  const pid = livePid(t);
  for (const [id, why] of [
    ["live", `running (pid ${pid})`],
    ["foreign", "locked: keep"],
    ["empty", "locked: "],
  ]) {
    const path = f.agent(id);
    f.lock(path, id === "live" ? lockReason(path, pid) : id === "empty" ? "" : "keep");
    assert.deepEqual(f.run(["agent", path]), {
      status: 1,
      stdout: "",
      stderr: `kept ${path}: ${why}\n`,
    });
    assert(existsSync(join(path, "tracked")));
  }
  const stale = f.agent("dead");
  f.lock(stale, lockReason(stale, deadPid()));
  assert.deepEqual(f.run(["agent", stale]), success(`removed ${stale}\n`));
  assert(!f.cmd(f.main, "worktree", "list").includes(stale));
});

test("agent preserves a branch with unpublished commits", () => {
  const f = setup();
  const path = f.agent("local");
  f.cmd(path, "commit", "--allow-empty", "-m", "local");
  const head = f.cmd(path, "rev-parse", "HEAD");
  assert.deepEqual(
    f.run(["agent", path]),
    success(`removed ${path}\nkept branch worktree-agent-local: commits not on origin\n`),
  );
  assert(!existsSync(path));
  assert.equal(f.cmd(f.main, "rev-parse", "worktree-agent-local"), head);
});

test("agent refuses unmanaged paths and invalid arguments and tolerates repeated removal", () => {
  const f = setup();
  const other = f.add(join(f.main, ".claude/worktrees/feature-x"), "--detach");
  for (const path of [other, f.main, f.t3("verifier", "--detach")]) {
    assert.deepEqual(f.run(["agent", path]), {
      status: 1,
      stdout: "",
      stderr: `kept ${path}: not a Claude Code agent worktree\n`,
    });
    assert(existsSync(path));
  }
  const path = f.agent("x");
  for (const args of [[], ["relative"], [path, "extra"]])
    assert.equal(f.run(["agent", ...args]).status, 2);
  assert.deepEqual(f.run(["agent", path]), success(`removed ${path}\n`));
  assert.deepEqual(f.run(["agent", path]), success(`absent ${path}\n`));
  mkdirSync(path);
  assert.deepEqual(f.run(["agent", path]), {
    status: 1,
    stdout: "",
    stderr: `kept ${path}: not a registered worktree\n`,
  });
  assert(existsSync(path));
});

test("sweep orders aged agents before T3, skips unmanaged paths and is repeatable", (t) => {
  const f = setup();
  const pid = livePid(t);
  const paths = ["dirty", "fresh", "live", "dead"].map((id) =>
    f.aged(f.agent(id), id === "fresh" ? 1 : 25),
  );
  const [dirty, fresh, live, dead] = paths;
  f.lock(live, lockReason(live, pid));
  f.lock(dead, lockReason(dead, deadPid()));
  writeFileSync(join(dirty, "tracked"), "changed");
  const outside = f.add(join(tempDir(), "outside"), "--detach");
  const other = f.aged(f.add(join(f.main, ".claude/worktrees/feature-x"), "--detach"), 25);
  const listed = f.t3("listed", "-b", "t3/owner");
  const kept = `kept ${fresh}: created 1h ago\nkept ${live}: running (pid ${pid})\nkept ${listed}: listed\n`;
  assert.deepEqual(
    f.run(["sweep", "--keep", listed]),
    success(`removed ${dead}\nremoved ${dirty}\n` + kept, `discard ${dirty}:  M tracked\n`),
  );
  assert.deepEqual(f.run(["sweep", "--keep", listed]), success(kept));
  for (const path of [fresh, live, other, outside, listed]) assert(existsSync(path));
  for (const path of [dead, dirty]) assert(!existsSync(path));
});

test("sweep removes settled PR verifiers and old unlisted owners", () => {
  const f = setup();
  const author = f.t3("owner", "-b", "t3/issue-1-x");
  f.cmd(author, "commit", "--allow-empty", "-m", "PR");
  f.cmd(author, "push", "origin", "HEAD");
  f.cmd(author, "checkout", "-b", "t3/owner", "origin/main");
  f.cmd(f.main, "fetch", "origin");
  const verifier = f.t3("verify", "--detach");
  f.cmd(verifier, "checkout", "--detach", "origin/t3/issue-1-x");
  f.aged(verifier, 2);
  const alias = join(tempDir(), "alias");
  symlinkSync(verifier, alias);
  assert.deepEqual(
    f.run(["sweep", "--keep", alias]),
    success(`kept ${author}: created 0m ago\nkept ${verifier}: listed\n`),
  );
  f.aged(author, 2);
  assert.deepEqual(
    f.run(["sweep", "--keep", author]),
    success(`kept ${author}: listed\nremoved ${verifier}\n`),
  );
  assert.deepEqual(f.run(["sweep", "--keep-none"]), success(`removed ${author}\n`));
  assert(f.branches().includes("t3/owner"));
  assert(!existsSync(verifier));
  assert(!existsSync(author));
});

test("sweep distinguishes untracked and ignored files and respects T3 locks", () => {
  const f = setup();
  const [dirty, ignored, locked] = ["dirty", "ignored", "locked"].map((id) =>
    f.aged(f.t3(id, "--detach"), 2),
  );
  f.cmd(f.main, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(dirty, "extra"), "");
  mkdirSync(join(ignored, "target"));
  writeFileSync(join(ignored, "target/output"), "");
  f.lock(locked, lockReason(locked, deadPid()));
  assert.deepEqual(
    f.run(["sweep", "--keep-none"]),
    success(`kept ${dirty}: uncommitted changes\nremoved ${ignored}\nkept ${locked}: locked\n`),
  );
  assert(existsSync(join(dirty, "extra")));
  assert(!existsSync(ignored));
  assert(existsSync(locked));
});

test("sweep preserves local commits reachable from HEAD or its detached reflog", () => {
  const f = setup();
  const [head, history] = ["head", "history"].map((id) => f.aged(f.t3(id, "--detach"), 2));
  for (const path of [head, history]) f.cmd(path, "commit", "--allow-empty", "-m", "local");
  f.cmd(history, "checkout", "--detach", "origin/main");
  assert.deepEqual(
    f.run(["sweep", "--keep-none"]),
    success(`kept ${head}: HEAD not on origin\nkept ${history}: commits only in HEAD history\n`),
  );
  assert(existsSync(head));
  assert(existsSync(history));
});

test("sweep validates every keep path and flag before removing anything", () => {
  const f = setup();
  const path = f.aged(f.agent("old"), 25);
  const plain = tempDir();
  const absent = join(plain, "absent");
  const list = () => f.cmd(f.main, "worktree", "list", "--porcelain");
  const before = list();
  for (const args of [
    [],
    ["--keep"],
    ["--keep", "relative"],
    ["--keep", path, "--keep-none"],
    ["--unknown"],
    [path],
  ]) {
    assert.equal(f.run(["sweep", ...args]).status, 2);
    assert.equal(list(), before);
  }
  assert.deepEqual(f.run(["sweep", "--keep", absent, "--keep", plain]), {
    status: 2,
    stdout: "",
    stderr: `worktrees: --keep ${absent} is not a worktree (does not exist)\nworktrees: --keep ${plain} is not a worktree (exists but is not a registered worktree)\n`,
  });
  assert.equal(list(), before);
  assert(existsSync(path));
});

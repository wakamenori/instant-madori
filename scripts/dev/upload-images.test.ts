import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

const script = resolve(import.meta.dirname, "upload-images.ts");
const png = (text: string) =>
  Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(text)]);
const repository = "https://github.com/wakamenori/instant-madori";
const blobId = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const storedName = (name: string, bytes: Buffer) =>
  `${basename(name, extname(name))}-${blobId(bytes).slice(0, 12)}${extname(name)}`;
const imagePath = (name: string, bytes: Buffer, issue = 297) =>
  `issue-${issue}/${storedName(name, bytes)}`;
const markdown = (name: string, bytes: Buffer, commit: string, issue = 297) =>
  `![${basename(name, extname(name))}](${repository}/blob/${commit}/${imagePath(name, bytes, issue)}?raw=true)\n`;

type Outcome = { status: number; stdout: string; stderr: string };

const updateHook = String.raw`
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.cwd();
const [ref, old] = process.argv.slice(2);
const modeFile = join(directory, "upload-mode");
const mode = readFileSync(modeFile, "utf8");
appendFileSync(join(directory, "upload-calls"), ref + "\n");
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
if (mode === "reject") {
  process.stderr.write("fixture upload rejected\n");
  process.exit(1);
}
if (mode === "once" || mode === "always" || mode === "late") {
  const rival = mode === "always"
    ? git(["commit-tree", git(["rev-parse", old + "^{tree}"]), "-p", old, "-m", "rival " + old])
    : readFileSync(join(directory, "upload-rival"), "utf8").trim();
  if (mode !== "always") writeFileSync(modeFile, "off");
  if (mode === "late") {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      'import {spawnSync} from "node:child_process"; setTimeout(() => { const r = spawnSync("git", ["update-ref", process.argv[1], process.argv[2], process.argv[3]]); process.exit(r.status ?? 1); }, 300);',
      ref, rival, old], { cwd: directory, env: process.env, detached: true, stdio: "ignore" });
    child.unref();
  } else {
    git(["update-ref", ref, rival, old]);
  }
  process.exit(1);
}
`;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "madori-images-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "origin.git");
  const clone = join(directory, "clone");
  const a = join(directory, "wt-a");
  const b = join(directory, "wt-b");
  const hooks = join(directory, "hooks");
  const remoteHooks = join(directory, "remote-hooks");
  mkdirSync(hooks);
  mkdirSync(remoteHooks);
  const globalConfig = join(directory, "gitconfig");
  writeFileSync(
    globalConfig,
    `[user]\nname = Image Test\nemail = images@example.invalid\n[init]\ndefaultBranch = main\n[fetch]\nprune = true\npruneTags = true\n[push]\nfollowTags = true\nautoSetupRemote = true\ndefault = simple\n[log]\nshowRoot = false\n[core]\nhooksPath = ${hooks}\n[protocol "ext"]\nallow = always\n`,
  );
  writeFileSync(
    join(hooks, "pre-push"),
    `#!${process.execPath}\nprocess.stderr.write("caller pre-push must not run\\n"); process.exit(1);\n`,
    { mode: 0o755 },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "INIT_CWD"),
  );
  env["GIT_CONFIG_GLOBAL"] = globalConfig;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_AUTHOR_DATE"] = "2026-11-20T00:00:00Z";
  env["GIT_COMMITTER_DATE"] = "2026-11-20T00:00:00Z";

  function git(cwd: string, args: string[], input?: string | Buffer): Outcome {
    const result = spawnSync("git", args, {
      cwd,
      env,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 ** 2,
    });
    if (result.error) throw result.error;
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }
  function ok(cwd: string, args: string[], input?: string | Buffer): string {
    const result = git(cwd, args, input);
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
    return result.stdout.trim();
  }
  function tree(entries: Map<string, string>): string {
    return ok(
      remote,
      ["mktree", "-z"],
      [...entries].map(([name, value]) => `${value}\t${name}\0`).join(""),
    );
  }
  function entries(treeId: string): Map<string, string> {
    return new Map(
      ok(remote, ["ls-tree", "-z", treeId])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("\t");
          return [line.slice(separator + 1), line.slice(0, separator)];
        }),
    );
  }
  function blob(bytes: Buffer): string {
    return ok(remote, ["hash-object", "-w", "--stdin"], bytes);
  }
  function commit(parent: string | undefined, path: string, bytes: Buffer): string {
    const slash = path.indexOf("/");
    const folderName = path.slice(0, slash);
    const fileName = path.slice(slash + 1);
    const root = parent ? entries(parent) : new Map<string, string>();
    const folderEntry = root.get(folderName);
    const folder = folderEntry
      ? entries(folderEntry.split(" ").at(-1) ?? "")
      : new Map<string, string>();
    folder.set(fileName, `100644 blob ${blob(bytes)}`);
    root.set(folderName, `040000 tree ${tree(folder)}`);
    return ok(remote, [
      "commit-tree",
      tree(root),
      ...(parent ? ["-p", parent] : []),
      "-m",
      `add ${path}`,
    ]);
  }
  function tip() {
    return ok(remote, ["rev-parse", "refs/heads/images"]);
  }
  function setTip(commitId: string) {
    ok(remote, ["update-ref", "refs/heads/images", commitId]);
  }
  function mode(value: string, rival = "") {
    writeFileSync(join(remote, "upload-mode"), value);
    writeFileSync(join(remote, "upload-rival"), rival);
    writeFileSync(join(remote, "upload-calls"), "");
  }
  function calls() {
    return readFileSync(join(remote, "upload-calls"), "utf8").split("\n").filter(Boolean).length;
  }
  function image(cwd: string, name: string, bytes = png(name)) {
    const path = join(cwd, name);
    writeFileSync(path, bytes);
    return { path, name, bytes };
  }
  function run(cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<Outcome> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd,
        env: { ...env, ...overrides },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolveRun({ status: status ?? 1, stdout, stderr }));
    });
  }
  function upload(cwd: string, ...files: string[]) {
    return run(cwd, ["--issue", "297", ...files]);
  }
  function content(commitId: string, path: string): Buffer {
    const result = spawnSync("git", ["show", `${commitId}:${path}`], { cwd: remote, env });
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout;
  }

  ok(directory, ["init", "--bare", remote]);
  ok(remote, ["config", "core.hooksPath", remoteHooks]);
  const mainTree = tree(new Map([["main.txt", `100644 blob ${blob(Buffer.from("main"))}`]]));
  const mainRoot = ok(remote, ["commit-tree", mainTree, "-m", "main root"]);
  const otherTree = tree(
    new Map([["upstream.txt", `100644 blob ${blob(Buffer.from("upstream"))}`]]),
  );
  const otherRoot = ok(remote, ["commit-tree", otherTree, "-m", "upstream root"]);
  const main = ok(remote, [
    "commit-tree",
    mainTree,
    "-p",
    mainRoot,
    "-p",
    otherRoot,
    "-m",
    "merge upstream",
  ]);
  ok(remote, ["update-ref", "refs/heads/main", main]);
  const seedBytes = png("seed");
  const seedRoot = commit(undefined, "issue-288/seed.png", seedBytes);
  const hashedSeedRootTree = entries(seedRoot);
  const seedFolder = entries(ok(remote, ["rev-parse", `${seedRoot}:issue-288`]));
  seedFolder.set(storedName("seed.png", seedBytes), `100644 blob ${blob(seedBytes)}`);
  hashedSeedRootTree.set("issue-288", `040000 tree ${tree(seedFolder)}`);
  const imagesRoot = ok(remote, ["commit-tree", tree(hashedSeedRootTree), "-m", "images root"]);
  setTip(imagesRoot);
  ok(directory, ["clone", remote, clone]);
  ok(clone, ["tag", "-a", "local-only", "-m", "keep local"]);
  ok(clone, ["update-ref", "refs/remotes/origin/stale", main]);
  ok(clone, ["worktree", "add", "-b", "work-a", a]);
  ok(clone, ["worktree", "add", "-b", "work-b", b]);
  writeFileSync(join(a, "main.txt"), "staged\n");
  ok(a, ["add", "main.txt"]);
  writeFileSync(join(a, "main.txt"), "unstaged\n");
  writeFileSync(join(a, "untracked.txt"), "untracked\n");
  const oldTip = commit(imagesRoot, "issue-288/later.png", png("after clone"));
  setTip(oldTip);
  mode("off");
  writeFileSync(join(remoteHooks, "update"), `#!${process.execPath}\n${updateHook}`, {
    mode: 0o755,
  });
  return {
    directory,
    remote,
    clone,
    a,
    b,
    env,
    git,
    ok,
    tree,
    entries,
    commit,
    tip,
    setTip,
    mode,
    calls,
    image,
    run,
    upload,
    content,
    main,
    imagesRoot,
    oldTip,
    seedBytes,
  };
}

type Fixture = ReturnType<typeof fixture>;
function succeeded(result: Outcome) {
  assert.equal(result.status, 0, result.stderr);
}
function failed(result: Outcome) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
}
function callerState(f: Fixture, cwd: string) {
  return {
    head: f.ok(cwd, ["rev-parse", "HEAD"]),
    status: f.ok(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    index: readFileSync(resolve(cwd, f.ok(cwd, ["rev-parse", "--git-path", "index"]))),
    refs: f
      .ok(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"])
      .split("\n")
      .filter((line) => !line.startsWith("refs/remotes/origin/images ")),
  };
}
function verifyLink(f: Fixture, line: string, bytes: Buffer) {
  const match =
    /^!\[[^\]]+\]\(https:\/\/github.com\/wakamenori\/instant-madori\/blob\/([0-9a-f]{40})\/(issue-[0-9]+\/[^?]+)\?raw=true\)$/u.exec(
      line,
    );
  assert.ok(match, line);
  const [, commitId, path] = match;
  assert.ok(commitId && path);
  assert.deepEqual(f.content(commitId, path), bytes);
}

void test("fetches an unseen tip and uploads two images without changing the dirty caller", async (t) => {
  const f = fixture(t);
  const first = f.image(f.a, "first.png");
  const second = f.image(f.a, "second.png");
  assert.notEqual(f.git(f.a, ["cat-file", "-e", f.oldTip]).status, 0);
  const before = callerState(f, f.a);
  const result = await f.upload(f.a, first.path, second.path);
  succeeded(result);
  const tip = f.tip();
  assert.equal(
    result.stdout,
    markdown(first.name, first.bytes, tip) + markdown(second.name, second.bytes, tip),
  );
  assert.deepEqual(f.content(tip, imagePath(first.name, first.bytes)), first.bytes);
  assert.deepEqual(f.content(tip, imagePath(second.name, second.bytes)), second.bytes);
  assert.equal(f.ok(f.remote, ["show", "-s", "--format=%P", tip]), f.oldTip);
  const mergeBase = f.git(f.remote, ["merge-base", "main", "images"]);
  assert.equal(mergeBase.status, 1);
  assert.equal(mergeBase.stdout, "");
  assert.deepEqual(callerState(f, f.a), before);
  for (const cwd of [f.a, f.clone]) {
    assert.equal(
      existsSync(resolve(cwd, f.ok(cwd, ["rev-parse", "--git-path", "FETCH_HEAD"]))),
      false,
    );
  }
  assert.equal(
    f.git(f.remote, ["show-ref", "--verify", "--quiet", "refs/tags/local-only"]).status,
    1,
  );
  assert.match(
    result.stderr,
    /^added issue-297\/first-[0-9a-f]{12}\.png in [0-9a-f]{12}\nadded issue-297\/second-[0-9a-f]{12}\.png in [0-9a-f]{12}\n$/u,
  );
});

void test("reuses adding commits on reruns, mixed uploads, duplicates and root files", async (t) => {
  const f = fixture(t);
  const first = f.image(f.a, "first.png");
  const result = await f.upload(f.a, first.path);
  succeeded(result);
  const firstTip = f.tip();
  const rerun = await f.upload(f.a, first.path);
  succeeded(rerun);
  assert.equal(rerun.stdout, result.stdout);
  assert.equal(f.tip(), firstTip);
  assert.equal(
    rerun.stderr,
    `reused ${imagePath(first.name, first.bytes)} from ${firstTip.slice(0, 12)}\n`,
  );
  const second = f.image(f.a, "second.png");
  const mixed = await f.upload(f.a, second.path, first.path, second.path);
  succeeded(mixed);
  const secondTip = f.tip();
  assert.equal(
    mixed.stdout,
    markdown(second.name, second.bytes, secondTip) +
      markdown(first.name, first.bytes, firstTip) +
      markdown(second.name, second.bytes, secondTip),
  );
  assert.equal(mixed.stderr.split("\n").filter(Boolean).length, 2);
  assert.equal(
    f.ok(f.remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", firstTip, secondTip]),
    imagePath(second.name, second.bytes),
  );
  const reuseAfterNewTip = await f.upload(f.a, first.path);
  succeeded(reuseAfterNewTip);
  assert.equal(reuseAfterNewTip.stdout, result.stdout);
  assert.equal(f.tip(), secondTip);
  const seed = f.image(f.a, "seed.png", f.seedBytes);
  const rootReuse = await f.run(f.a, ["--issue", "288", seed.path]);
  succeeded(rootReuse);
  assert.equal(rootReuse.stdout, markdown(seed.name, seed.bytes, f.imagesRoot, 288));
  assert.equal(f.tip(), secondTip);
});

void test("simultaneous uploads with the same local name keep both contents", async (t) => {
  const f = fixture(t);
  const a = f.image(f.a, "after.png", png("a"));
  const b = f.image(f.b, "after.png", png("b"));
  const results = await Promise.all([f.upload(f.a, a.path), f.upload(f.b, b.path)]);
  for (const [index, image] of [a, b].entries()) {
    const result = results[index];
    assert.ok(result);
    succeeded(result);
    verifyLink(f, result.stdout.trim(), image.bytes);
    assert.deepEqual(f.content(f.tip(), imagePath(image.name, image.bytes)), image.bytes);
  }
  assert.notEqual(storedName(a.name, a.bytes), storedName(b.name, b.bytes));
});

for (const identical of [false, true]) {
  void test(`re-stacks a deterministic rival that adds ${identical ? "the identical path" : "a different path"}`, async (t) => {
    const f = fixture(t);
    const ours = f.image(f.a, "ours.png");
    const rivalPath = identical ? imagePath(ours.name, ours.bytes) : "issue-297/rival.png";
    const rivalBytes = identical ? ours.bytes : png("rival");
    const rival = f.commit(f.oldTip, rivalPath, rivalBytes);
    f.mode("once", rival);
    const result = await f.upload(f.a, ours.path);
    succeeded(result);
    assert.match(result.stderr, /re-stacking \(attempt 2 of 10\)/u);
    assert.equal(f.calls(), identical ? 1 : 2);
    if (identical) {
      assert.equal(f.tip(), rival);
      assert.equal(result.stdout, markdown(ours.name, ours.bytes, rival));
      assert.match(result.stderr, /reused /u);
    } else {
      assert.equal(f.ok(f.remote, ["show", "-s", "--format=%P", f.tip()]), rival);
      assert.deepEqual(f.content(f.tip(), rivalPath), rivalBytes);
      assert.deepEqual(f.content(f.tip(), imagePath(ours.name, ours.bytes)), ours.bytes);
    }
  });
}

void test("preserves a rival that lands before receive-pack advertises its refs", async (t) => {
  const f = fixture(t);
  const ours = f.image(f.a, "ours.png");
  const rivalBytes = png("before receive-pack");
  const rival = f.commit(f.oldTip, "issue-297/rival.png", rivalBytes);
  const receiver = join(f.directory, "receive.mjs");
  writeFileSync(
    receiver,
    `import { spawnSync } from "node:child_process";
const remote = process.argv[2];
const env = { ...process.env };
for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE"]) delete env[key];
spawnSync("git", ["--git-dir", remote, "update-ref", "refs/heads/images", "${rival}", "${f.oldTip}"], { env });
const received = spawnSync("git", ["receive-pack", remote], { env, stdio: "inherit" });
process.exit(received.status ?? 1);
`,
  );
  f.ok(f.a, [
    "config",
    "remote.origin.pushurl",
    `ext::${process.execPath} ${receiver} ${f.remote}`,
  ]);
  const result = await f.upload(f.a, ours.path);
  succeeded(result);
  assert.deepEqual(f.content(f.tip(), "issue-297/rival.png"), rivalBytes);
  assert.equal(f.ok(f.remote, ["show", "-s", "--format=%P", f.tip()]), rival);
  assert.match(result.stderr, /re-stacking/u);
  assert.equal(f.calls(), 1);
  verifyLink(f, result.stdout.trim(), ours.bytes);
});

void test("waits for a slow rival after a refused push", async (t) => {
  const f = fixture(t);
  const ours = f.image(f.a, "ours.png");
  const rivalBytes = png("late rival");
  const rival = f.commit(f.oldTip, "issue-297/rival.png", rivalBytes);
  f.mode("late", rival);
  const result = await f.upload(f.a, ours.path);
  succeeded(result);
  assert.equal(f.calls(), 2);
  assert.equal(f.ok(f.remote, ["show", "-s", "--format=%P", f.tip()]), rival);
  assert.deepEqual(f.content(f.tip(), "issue-297/rival.png"), rivalBytes);
  assert.deepEqual(f.content(f.tip(), imagePath(ours.name, ours.bytes)), ours.bytes);
  assert.match(result.stderr, /re-stacking/u);
});

void test("stops after ten competing uploads without publishing its paths", async (t) => {
  const f = fixture(t);
  const ours = f.image(f.a, "ours.png");
  f.mode("always");
  const result = await f.upload(f.a, ours.path);
  failed(result);
  assert.match(result.stderr, /images kept moving: 10 other uploads landed/u);
  assert.equal(f.calls(), 10);
  assert.equal(f.ok(f.remote, ["rev-list", "--count", `${f.oldTip}..${f.tip()}`]), "10");
  assert.notEqual(
    f.git(f.remote, ["cat-file", "-e", `${f.tip()}:${imagePath(ours.name, ours.bytes)}`]).status,
    0,
  );
});

void test("reports a real push rejection after the grace reads", async (t) => {
  const f = fixture(t);
  const ours = f.image(f.a, "ours.png");
  f.mode("reject");
  const result = await f.upload(f.a, ours.path);
  failed(result);
  assert.match(result.stderr, /fixture upload rejected/u);
  assert.equal(f.calls(), 1);
  assert.equal(f.tip(), f.oldTip);
});

void test("refuses a stored path edited by hand before pushing anything", async (t) => {
  const f = fixture(t);
  const ours = f.image(f.a, "ours.png");
  const editedPath = imagePath(ours.name, ours.bytes);
  const edited = f.commit(f.oldTip, editedPath, png("edited"));
  f.setTip(edited);
  const result = await f.upload(f.a, ours.path);
  failed(result);
  assert.ok(result.stderr.includes(editedPath));
  assert.match(result.stderr, /different bytes/u);
  assert.equal(f.tip(), edited);
  assert.equal(f.calls(), 0);
});

void test("concurrent worktrees keep every file and identical uploads share their adding commit", async (t) => {
  const f = fixture(t);
  const jobs = [
    { cwd: f.a, image: f.image(f.a, "one.png") },
    { cwd: f.b, image: f.image(f.b, "two.png") },
    { cwd: f.a, image: f.image(f.a, "three.png") },
    { cwd: f.b, image: f.image(f.b, "four.png") },
    { cwd: f.a, image: f.image(f.a, "same.png", png("same")) },
    { cwd: f.b, image: f.image(f.b, "same.png", png("same")) },
  ];
  const beforeA = callerState(f, f.a);
  const beforeB = callerState(f, f.b);
  const results = await Promise.all(jobs.map(({ cwd, image }) => f.upload(cwd, image.path)));
  for (const [index, { image }] of jobs.entries()) {
    const result = results[index];
    assert.ok(result);
    succeeded(result);
    verifyLink(f, result.stdout.trim(), image.bytes);
    assert.deepEqual(f.content(f.tip(), imagePath(image.name, image.bytes)), image.bytes);
  }
  assert.equal(results.at(-1)?.stdout, results.at(-2)?.stdout);
  assert.deepEqual(callerState(f, f.a), beforeA);
  assert.deepEqual(callerState(f, f.b), beforeB);
});

void test("refuses a missing images branch without creating one", async (t) => {
  const f = fixture(t);
  const ours = f.image(f.a, "ours.png");
  f.ok(f.remote, ["update-ref", "-d", "refs/heads/images"]);
  const result = await f.upload(f.a, ours.path);
  failed(result);
  assert.match(result.stderr, /no images branch/u);
  assert.equal(f.git(f.remote, ["show-ref", "--verify", "--quiet", "refs/heads/images"]).status, 1);
  assert.equal(f.calls(), 0);
});

for (const merge of [false, true]) {
  void test(`refuses images history that ${merge ? "merges" : "descends from"} main`, async (t) => {
    const f = fixture(t);
    const ours = f.image(f.a, "ours.png");
    const tree = f.ok(f.remote, ["rev-parse", `${f.oldTip}^{tree}`]);
    const foreign = f.ok(f.remote, [
      "commit-tree",
      tree,
      "-p",
      f.main,
      ...(merge ? ["-p", f.oldTip] : []),
      "-m",
      "foreign history",
    ]);
    f.setTip(foreign);
    const result = await f.upload(f.a, ours.path);
    failed(result);
    assert.match(result.stderr, /another branch's history/u);
    assert.equal(f.tip(), foreign);
    assert.equal(f.calls(), 0);
  });
}

void test("rejects bad input before talking to origin and offers help", async (t) => {
  const f = fixture(t);
  const valid = f.image(f.a, "valid.png");
  f.ok(f.a, ["remote", "set-url", "origin", join(f.directory, "missing.git")]);
  const invalidArgs = [
    ...["", "0", "-1", "01", "1.5", "10000000", "abc", "1e3"].map((issue) => [
      "--issue",
      issue,
      valid.path,
    ]),
    ["--issue", "297", "--issue", "298", valid.path],
    ["--issue", "297"],
    [valid.path],
    ["--unknown", valid.path],
  ];
  for (const name of [
    "Upper.png",
    "a b.png",
    "a..b.png",
    "a--b.png",
    "a_.png",
    "a.svg",
    `${"a".repeat(97)}.png`,
  ]) {
    invalidArgs.push(["--issue", "297", f.image(f.a, name).path]);
  }
  for (const extension of ["png", "jpg", "jpeg", "gif", "webp"]) {
    invalidArgs.push([
      "--issue",
      "297",
      f.image(f.a, `wrong.${extension}`, Buffer.from("wrong signature")).path,
    ]);
  }
  invalidArgs.push(["--issue", "297", f.image(f.a, "empty.png", Buffer.alloc(0)).path]);
  invalidArgs.push([
    "--issue",
    "297",
    f.image(f.a, "huge.png", Buffer.alloc(10 * 1024 ** 2 + 1)).path,
  ]);
  invalidArgs.push(["--issue", "297", join(f.a, "missing.png")]);
  const folder = join(f.a, "directory.png");
  mkdirSync(folder);
  invalidArgs.push(["--issue", "297", folder]);
  for (const args of invalidArgs) {
    const result = await f.run(f.a, args);
    failed(result);
    assert.doesNotMatch(
      result.stderr,
      /Reading images failed|does not appear to be a git repository/u,
      args.join(" "),
    );
  }
  const help = await f.run(f.a, ["--help"]);
  succeeded(help);
  assert.match(help.stdout, /^Usage: pnpm images:upload/u);
  assert.equal(help.stderr, "");
  assert.equal(f.calls(), 0);
});

void test("accepts every supported signature and resolves paths against INIT_CWD", async (t) => {
  const f = fixture(t);
  const input = join(f.directory, "inputs");
  mkdirSync(input);
  const images = [
    f.image(input, "valid.png"),
    f.image(input, "valid.jpg", Buffer.from("ffd8ff01", "hex")),
    f.image(input, "valid.jpeg", Buffer.from("ffd8ff02", "hex")),
    f.image(input, "old.gif", Buffer.from("GIF87a")),
    f.image(input, "new.gif", Buffer.from("GIF89a")),
    f.image(input, "valid.webp", Buffer.from("RIFF0000WEBP")),
  ];
  const result = await f.run(f.a, ["--issue", "297", ...images.map(({ name }) => name)], {
    INIT_CWD: input,
  });
  succeeded(result);
  assert.equal(
    result.stdout,
    images.map(({ name, bytes }) => markdown(name, bytes, f.tip())).join(""),
  );
  for (const image of images)
    assert.deepEqual(f.content(f.tip(), imagePath(image.name, image.bytes)), image.bytes);
});

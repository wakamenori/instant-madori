import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

export function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "madori-skill-")));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const gitDir = process.env.PATH.split(delimiter).find((dir) => existsSync(join(dir, "git")));
export function isolatedEnv(home, overrides = {}) {
  const global = join(home, "gitconfig");
  writeFileSync(global, "");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nimport(${JSON.stringify(new URL("fake-gh.mjs", import.meta.url).href)});\n`,
    { mode: 0o755 },
  );
  return {
    HOME: home,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    PATH: bin + delimiter + gitDir,
    GIT_AUTHOR_NAME: "Test",
    GIT_COMMITTER_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    ...overrides,
  };
}
export function runScript(name, args, options) {
  const file = fileURLToPath(new URL("../" + name, import.meta.url));
  const { status, stdout, stderr, error } = spawnSync(process.execPath, [file, ...args], {
    ...options,
    encoding: "utf8",
  });
  if (error) throw error;
  return { status, stdout, stderr };
}
export function fakeGitHub(dir, state, env) {
  const statePath = join(dir, "state.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(log, "");
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    env: { ...env, FAKE_GH_STATE: statePath, FAKE_GH_LOG: log },
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    calls,
    writes: () => calls().filter((call) => call.argv.includes("-X")),
  };
}
export function git(cwd, env, ...args) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
}
export function repository(files, env) {
  const root = tempDir();
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const coordinator = join(root, "coordinator");
  const run = (...args) => git(author, env, ...args);
  git(root, env, "init", "-q", "--bare", "-b", "main", origin);
  git(root, env, "init", "-q", "-b", "main", author);
  const commit = (changes) => {
    for (const [name, contents] of Object.entries(changes)) {
      const file = join(author, name);
      if (contents === null) rmSync(file);
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, contents);
      }
    }
    run("add", "-A");
    run("commit", "-qm", "changes");
  };
  commit(files);
  run("remote", "add", "origin", origin);
  const pushMain = () => run("push", "-q", "origin", "main");
  pushMain();
  git(root, env, "clone", "-q", origin, coordinator);
  return {
    coordinator,
    commit,
    pushMain,
    branch: (name, from) => run("checkout", "-qb", name, from),
    orphan: (name) => run("checkout", "-q", "--orphan", name),
    checkout: (name) => run("checkout", "-q", name),
    rename: (from, to) => {
      renameSync(join(author, from), join(author, to));
      commit({});
    },
    pushPull: (pr) => {
      run("push", "-q", "origin", `HEAD:refs/pull/${pr}/head`);
      return run("rev-parse", "HEAD");
    },
    merge: (branch, pr) => {
      run("checkout", "-q", "main");
      run("merge", "-q", "--no-ff", branch, "-m", `Merge #${pr}`);
      pushMain();
      return run("rev-parse", "HEAD");
    },
  };
}

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { git, isolatedEnv, runScript, tempDir } from "./testing/support.mjs";

function setup() {
  const root = tempDir();
  const home = join(root, "home");
  mkdirSync(home);
  const env = isolatedEnv(home);
  const main = join(root, "main");
  git(root, env, "init", "-q", "-b", "main", main);
  git(main, env, "commit", "-q", "--allow-empty", "-m", "base");
  const worktree = join(root, "worktree");
  git(main, env, "worktree", "add", "-q", "-b", "issue", worktree);
  const config = join(root, "config");

  const install = (name, { skill = true } = {}) => {
    const dir = join(root, "cache", name);
    mkdirSync(join(dir, "skills/poteto-mode"), { recursive: true });
    if (skill) writeFileSync(join(dir, "skills/poteto-mode/SKILL.md"), "# Poteto mode\n");
    return dir;
  };
  const skillOf = (dir) => join(dir, "skills/poteto-mode/SKILL.md");
  const record = (plugins, dir = config) => {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(
      join(dir, "plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins }),
    );
  };
  const run = ({ cwd = main, overrides = { CLAUDE_CONFIG_DIR: config } } = {}) =>
    runScript("poteto-mode.mjs", [], { cwd, env: isolatedEnv(home, overrides) });
  return { home, main, worktree, config, install, skillOf, record, run };
}

void test("prints the user install when nothing is installed for this repository", () => {
  const s = setup();
  const user = s.install("user");
  s.record({ "pstack@market": [{ scope: "user", installPath: user, version: "0.15.36" }] });
  assert.deepEqual(s.run(), { status: 0, stdout: `${s.skillOf(user)}\n`, stderr: "" });
});

void test("local beats project beats user for this repository, whatever the order and versions", () => {
  const s = setup();
  const user = s.install("z-market/pstack/0.15.36");
  const project = s.install("a-market/pstack/0.15.9");
  const local = s.install("m-market/pstack/0.15.1");
  const records = [
    { scope: "user", installPath: user, version: "0.15.36" },
    { scope: "project", projectPath: s.main, installPath: project, version: "0.15.9" },
    { scope: "local", projectPath: s.main, installPath: local, version: "0.15.1" },
  ];
  s.record({ "pstack@market": records });
  assert.equal(s.run().stdout, `${s.skillOf(local)}\n`);
  s.record({ "pstack@market": records.slice(0, 2) });
  assert.equal(s.run().stdout, `${s.skillOf(project)}\n`);
});

void test("from a linked worktree, installs for the main checkout and for the worktree both match", () => {
  const s = setup();
  const user = s.install("user");
  const forMain = s.install("for-main");
  const forWorktree = s.install("for-worktree");
  s.record({
    "pstack@market": [
      { scope: "user", installPath: user },
      { scope: "local", projectPath: s.main, installPath: forMain },
    ],
  });
  assert.equal(s.run({ cwd: s.worktree }).stdout, `${s.skillOf(forMain)}\n`);
  s.record({
    "pstack@market": [
      { scope: "user", installPath: user },
      { scope: "project", projectPath: s.worktree, installPath: forWorktree },
    ],
  });
  assert.equal(s.run({ cwd: s.worktree }).stdout, `${s.skillOf(forWorktree)}\n`);
});

void test("installs recorded for another project are ignored", () => {
  const s = setup();
  const user = s.install("user");
  const other = s.install("other");
  s.record({
    "pstack@market": [
      { scope: "local", projectPath: "/elsewhere", installPath: other },
      { scope: "local", projectPath: dirname(s.main), installPath: other },
      { scope: "project", projectPath: join(s.main, "sub"), installPath: other },
      { scope: "user", installPath: user },
    ],
  });
  assert.equal(s.run().stdout, `${s.skillOf(user)}\n`);
});

void test("only keys starting with pstack@ count", () => {
  const s = setup();
  const user = s.install("user");
  const beta = s.install("beta");
  s.record({
    "pstack-beta@market": [{ scope: "local", projectPath: s.main, installPath: beta }],
    "other@market": [{ scope: "local", projectPath: s.main, installPath: beta }],
    "pstack@market": [{ scope: "user", installPath: user }],
  });
  assert.equal(s.run().stdout, `${s.skillOf(user)}\n`);
});

void test("reads CLAUDE_CONFIG_DIR, and ~/.claude when it is unset or empty", () => {
  const s = setup();
  const inConfig = s.install("in-config");
  const inHome = s.install("in-home");
  s.record({ "pstack@market": [{ scope: "user", installPath: inConfig }] });
  s.record({ "pstack@market": [{ scope: "user", installPath: inHome }] }, join(s.home, ".claude"));
  assert.equal(s.run().stdout, `${s.skillOf(inConfig)}\n`);
  assert.equal(
    s.run({ overrides: { CLAUDE_CONFIG_DIR: undefined } }).stdout,
    `${s.skillOf(inHome)}\n`,
  );
  assert.equal(s.run({ overrides: { CLAUDE_CONFIG_DIR: "" } }).stdout, `${s.skillOf(inHome)}\n`);
});

void test("fails without falling back when the chosen install has no SKILL.md", () => {
  const s = setup();
  const user = s.install("user");
  const broken = s.install("broken", { skill: false });
  s.record({
    "pstack@market": [
      { scope: "user", installPath: user },
      { scope: "local", projectPath: s.main, installPath: broken },
    ],
  });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^poteto-mode: poteto-mode SKILL\.md not found/);
});

void test("fails when installed_plugins.json is missing, not JSON, or has no pstack", () => {
  const s = setup();
  const cases = {
    missing: () => {},
    "not JSON": () => {
      mkdirSync(join(s.config, "plugins"), { recursive: true });
      writeFileSync(join(s.config, "plugins/installed_plugins.json"), "{");
    },
    "no pstack": () =>
      s.record({ "other@market": [{ scope: "user", installPath: s.install("other") }] }),
  };
  for (const [name, arrange] of Object.entries(cases)) {
    arrange();
    const result = s.run();
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, "", name);
    assert.match(result.stderr, /^poteto-mode: poteto-mode SKILL\.md not found/, name);
  }
});

void test("any argument is a usage error", () => {
  const home = tempDir();
  const result = runScript("poteto-mode.mjs", ["extra"], { cwd: home, env: isolatedEnv(home) });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^poteto-mode: usage/i);
});

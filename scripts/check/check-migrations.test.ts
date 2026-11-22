import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-migrations.ts", import.meta.url));
const migrationsPath = "apps/worker/migrations/";
const existing = `${migrationsPath}0002_revisions.sql`;

function repository(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "madori-migrations-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, content = "SELECT 1;\n") => writeFileSync(join(cwd, path), content);
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "test migration change");
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Migration test");
  git("config", "user.email", "migration-test@example.invalid");
  mkdirSync(join(cwd, migrationsPath), { recursive: true });
  write(`${migrationsPath}0001_users_projects_patterns.sql`);
  write(existing);
  commit();
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-c", "feature");
  return {
    cwd,
    git,
    write,
    commit,
    check: (base?: string) =>
      spawnSync(process.execPath, [script], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, MADORI_MIGRATION_BASE: base },
      }),
  };
}

function checkoutContext(repo: ReturnType<typeof repository>, context: string) {
  if (context === "branch") return;
  repo.git("switch", "main");
  repo.git("merge", "--no-ff", "feature", "-m", "merge feature");
  if (context !== "PR merge") repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (context !== "main") repo.git("switch", "--detach");
}

const changes = [
  {
    name: "changed",
    apply: (repo: ReturnType<typeof repository>) => repo.write(existing, "SELECT 2;\n"),
  },
  {
    name: "deleted",
    apply: (repo: ReturnType<typeof repository>) => rmSync(join(repo.cwd, existing)),
  },
  {
    name: "renamed",
    apply: (repo: ReturnType<typeof repository>) =>
      renameSync(join(repo.cwd, existing), join(repo.cwd, `${migrationsPath}0003_renamed.sql`)),
  },
];

for (const context of ["branch", "PR merge", "main", "detached main"]) {
  for (const change of changes) {
    void test(`rejects an existing migration ${change.name} on ${context}`, (t) => {
      const repo = repository(t);
      change.apply(repo);
      repo.commit();
      checkoutContext(repo, context);
      const result = repo.check();
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(existing), result.stderr);
      assert.match(result.stderr, /already on main/);
    });
  }

  for (const number of ["0000", "0001", "0002", "0003"]) {
    void test(`${context} ${number === "0003" ? "allows" : "rejects"} new migration ${number}`, (t) => {
      const repo = repository(t);
      const path = `${migrationsPath}${number}_new.sql`;
      repo.write(path);
      repo.commit();
      checkoutContext(repo, context);
      const result = repo.check();
      assert.equal(result.status, number === "0003" ? 0 : 1, result.stderr);
      if (number !== "0003") {
        assert.ok(result.stderr.includes(path), result.stderr);
        assert.match(result.stderr, /greater than 2/);
      }
    });
  }
}

void test("allows revising a migration across feature commits before it reaches main", (t) => {
  const repo = repository(t);
  const path = `${migrationsPath}0003_new.sql`;
  repo.write(path);
  repo.commit();
  repo.write(path, "SELECT 2;\n");
  repo.commit();
  assert.equal(repo.check().status, 0);
});

void test("checks unstaged, staged and untracked changes", (t) => {
  const repo = repository(t);
  repo.write(existing, "SELECT 2;\n");
  assert.match(repo.check().stderr, /already on main/);
  repo.git("add", existing);
  assert.match(repo.check().stderr, /already on main/);
  repo.git("restore", "--staged", "--worktree", existing);
  const path = `${migrationsPath}0002_untracked.sql`;
  repo.write(path);
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(path));
});

void test("uses the common ancestor when main advances independently", (t) => {
  const repo = repository(t);
  repo.write(`${migrationsPath}0003_feature.sql`);
  repo.commit();
  repo.git("switch", "main");
  repo.write(`${migrationsPath}0004_main.sql`);
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "feature");
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
});

void test("a PR merge includes migrations added on the base after the branch forked", (t) => {
  const repo = repository(t);
  repo.write(`${migrationsPath}0003_feature.sql`);
  repo.commit();
  repo.git("switch", "main");
  repo.write(`${migrationsPath}0004_main.sql`);
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("merge", "--no-ff", "feature", "-m", "PR merge");
  repo.git("switch", "--detach");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0003_feature.sql.*greater than 4/);
});

void test("a feature branch starting exactly at origin/main still protects every baseline file", (t) => {
  const repo = repository(t);
  repo.write(existing, "SELECT 2;\n");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already on main/);
});

void test("main uses its first parent for a non-merge commit too", (t) => {
  const repo = repository(t);
  repo.git("switch", "main");
  repo.write(existing, "SELECT 2;\n");
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already on main/);
});

void test("rejects an existing migration edited in an earlier commit of a direct push", (t) => {
  const repo = repository(t);
  repo.git("switch", "main");
  const before = repo.git("rev-parse", "HEAD");
  repo.write(existing, "SELECT 2;\n");
  repo.commit();
  repo.write("unrelated.txt");
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const result = repo.check(before);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(existing), result.stderr);
  assert.match(result.stderr, /already on main/);
});

void test("rejects an existing migration edited before a fast-forward push to a back-merge", (t) => {
  const repo = repository(t);
  repo.write(existing, "SELECT 2;\n");
  repo.commit();
  repo.git("switch", "main");
  repo.write("unrelated.txt");
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const before = repo.git("rev-parse", "HEAD");
  repo.git("switch", "feature");
  repo.git("merge", "--no-ff", "main", "-m", "back-merge main");
  repo.git("switch", "main");
  repo.git("merge", "--ff-only", "feature");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const result = repo.check(before);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(existing), result.stderr);
  assert.match(result.stderr, /already on main/);
});

void test("allows a clean push and reports the explicit base and its source", (t) => {
  const repo = repository(t);
  repo.git("switch", "main");
  const before = repo.git("rev-parse", "HEAD");
  repo.write(`${migrationsPath}0003_new.sql`);
  repo.commit();
  repo.write(`${migrationsPath}0004_new.sql`);
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const result = repo.check(before.toUpperCase());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(before), result.stdout);
  assert.match(result.stdout, /MADORI_MIGRATION_BASE/);
});

for (const base of ["", "0000000000000000000000000000000000000000"]) {
  void test(`falls back to the first parent for ${base === "" ? "an empty" : "an all-zero"} base`, (t) => {
    const repo = repository(t);
    repo.git("switch", "main");
    repo.write(existing, "SELECT 2;\n");
    repo.commit();
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const result = repo.check(base);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /already on main/);
  });
}

for (const base of ["HEAD", "main", "HEAD^"]) {
  void test(`rejects ${base} as an explicit migration base`, (t) => {
    const repo = repository(t);
    repo.git("switch", "main");
    repo.write(existing, "SELECT 2;\n");
    repo.commit();
    repo.write("unrelated.txt");
    repo.commit();
    const result = repo.check(base);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /MADORI_MIGRATION_BASE must be a full commit SHA/);
  });
}

void test("rejects an explicit base that does not exist", (t) => {
  const repo = repository(t);
  const result = repo.check("ffffffffffffffffffffffffffffffffffffffff");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not name a commit/);
});

void test("rejects an explicit base on a side branch outside the history of HEAD", (t) => {
  const repo = repository(t);
  repo.git("switch", "-c", "side");
  repo.write("side.txt");
  repo.commit();
  const base = repo.git("rev-parse", "HEAD");
  repo.git("switch", "main");
  repo.write("main.txt");
  repo.commit();
  const result = repo.check(base);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /not in the history of HEAD/);
});

void test("a detached PR head protects migrations edited before its last commit", (t) => {
  const repo = repository(t);
  repo.write(existing, "SELECT 2;\n");
  repo.commit();
  repo.write(`${migrationsPath}0003_new.sql`);
  repo.commit();
  repo.git("switch", "--detach");
  const result = repo.check();
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(existing), result.stderr);
  assert.match(result.stderr, /already on main/);
});

void test("local main ahead of origin/main protects migrations from HEAD's first parent", (t) => {
  const repo = repository(t);
  repo.git("switch", "main");
  const path = `${migrationsPath}0003_new.sql`;
  repo.write(path);
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.write(path, "SELECT 2;\n");
  repo.commit();
  const result = repo.check();
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(path), result.stderr);
  assert.match(result.stderr, /already on main/);
});

void test("fails with a fetch instruction when origin/main is absent", (t) => {
  const repo = repository(t);
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Fetch origin\/main/);
});

void test("requires a numeric migration filename", (t) => {
  const repo = repository(t);
  repo.write(`${migrationsPath}unnumbered.sql`);
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unnumbered.sql.*must start with a number/);
});

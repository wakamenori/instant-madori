import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename } from "node:path";

// The metrics L1 schema outlives every receiver version, so its migrations are immutable too.
const workerMigrations = "apps/worker/migrations/";
const migrationsPaths = [workerMigrations, "metrics/l1/migrations/"];

function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function migrationNumber(path: string) {
  const number = /^(\d+)/.exec(basename(path))?.[1];
  if (number === undefined)
    throw new Error(`${path}: migration filename must start with a number.`);
  return BigInt(number);
}

function resolveCommit(explicitBase: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(explicitBase))
    throw new Error("MADORI_MIGRATION_BASE must be a full commit SHA.");
  try {
    return git("rev-parse", "--verify", "--end-of-options", `${explicitBase}^{commit}`).trim();
  } catch {
    throw new Error(`MADORI_MIGRATION_BASE ${explicitBase} does not name a commit.`);
  }
}

function migrationBase() {
  const head = git("rev-parse", "HEAD").trim();
  let mainHead: string;
  try {
    mainHead = git("rev-parse", "--verify", "refs/remotes/origin/main").trim();
  } catch {
    throw new Error("Migration check needs origin/main and full history. Fetch origin/main first.");
  }
  const explicitBase = process.env["MADORI_MIGRATION_BASE"] ?? "";
  // Manual runs have no base; branch-creation pushes use an all-zero object ID.
  if (!/^0*$/.test(explicitBase)) {
    const commit = resolveCommit(explicitBase);
    try {
      git("merge-base", "--is-ancestor", commit, "HEAD");
    } catch {
      throw new Error(`MADORI_MIGRATION_BASE ${explicitBase} is not in the history of HEAD.`);
    }
    return { commit, source: "MADORI_MIGRATION_BASE" };
  }
  const branch = git("branch", "--show-current").trim();
  const onMain = branch === "main" || (branch === "" && head === mainHead);
  return onMain
    ? { commit: git("rev-parse", "HEAD^1").trim(), source: "first parent of HEAD" }
    : { commit: git("merge-base", "HEAD", mainHead).trim(), source: "merge base with origin/main" };
}

function checkMigrations(base: { commit: string }, migrationsPath: string) {
  const baseline = new Set(
    git("ls-tree", "-r", "--name-only", "-z", base.commit, "--", migrationsPath)
      .split("\0")
      .filter(Boolean),
  );
  const violations: string[] = [];
  let maxNumber = -1n;
  for (const path of baseline) {
    const number = migrationNumber(path);
    if (number > maxNumber) maxNumber = number;
  }
  const changed = git(
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "-z",
    base.commit,
    "--",
    migrationsPath,
  )
    .split("\0")
    .filter(Boolean);
  for (const path of changed) {
    if (baseline.has(path)) {
      violations.push(
        `${path}: migration already on main was changed, deleted or renamed. Add a new migration instead.`,
      );
    }
  }
  const current = new Set(
    git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", migrationsPath)
      .split("\0")
      .filter(Boolean),
  );
  for (const path of current) {
    if (!baseline.has(path) && migrationNumber(path) <= maxNumber) {
      violations.push(`${path}: new migration number must be greater than ${maxNumber} from main.`);
    }
  }
  return violations;
}

type MigrationBlobs = ReadonlyMap<string, string>;

function referenceMigrations(commit: string): MigrationBlobs {
  const files = new Map<string, string>();
  for (const entry of git("ls-tree", "-r", "-z", commit, "--", workerMigrations).split("\0")) {
    const tab = entry.indexOf("\t");
    const [, type, id] = entry.slice(0, tab).split(" ");
    if (type === "blob" && id !== undefined) files.set(entry.slice(tab + 1), id);
  }
  return files;
}

function deployedMigrations(): MigrationBlobs {
  const paths = readdirSync(workerMigrations).map((name) => workerMigrations + name);
  const ids = git("hash-object", "--no-filters", "--", ...paths)
    .trimEnd()
    .split("\n");
  return new Map(
    paths.map((path, index) => {
      const id = ids[index];
      if (!id) throw new Error(`Could not hash ${path}.`);
      return [path, id];
    }),
  );
}

function differingMigrations(deployed: MigrationBlobs, reference: MigrationBlobs): string[] {
  return [...deployed].filter(([path, id]) => reference.get(path) !== id).map(([path]) => path);
}

function checkBranchDeploy() {
  const base = process.env["MADORI_MIGRATION_BASE"] ?? "";
  if (/^0*$/.test(base)) throw new Error("There is no successful main deploy to compare with.");
  const commit = resolveCommit(base);
  const reference = referenceMigrations(commit);
  const deployed = deployedMigrations();
  const violations = differingMigrations(deployed, reference).map((path) =>
    reference.has(path)
      ? `${path}: differs from the last successful main deploy ${commit}. Staging D1 records migrations by file name, so it would never apply this content.`
      : `${path}: not in the last successful main deploy ${commit}. Staging D1 records migrations by file name, so a branch deploy may carry only migrations that main has deployed. Merge the migration to main, wait for its deploy, then deploy a branch that includes it.`,
  );
  if (violations.length > 0) throw new Error(violations.join("\n"));
  console.log(
    `Compared ${deployed.size} migration files with the last successful main deploy ${commit}.`,
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--branch-deploy") return checkBranchDeploy();
  if (args.length > 0)
    throw new Error("Usage: node scripts/check/check-migrations.ts [--branch-deploy]");
  const base = migrationBase();
  const violations = migrationsPaths.flatMap((path) => checkMigrations(base, path));
  if (violations.length > 0) throw new Error(violations.join("\n"));
  console.log(`Migration immutability check passed (base ${base.commit}, ${base.source}).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

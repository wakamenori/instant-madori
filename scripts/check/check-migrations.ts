import { execFileSync } from "node:child_process";
import { basename } from "node:path";

// The metrics L1 schema outlives every receiver version, so its migrations are immutable too.
const migrationsPaths = ["apps/worker/migrations/", "metrics/l1/migrations/"];

function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function migrationNumber(path: string) {
  const number = /^(\d+)/.exec(basename(path))?.[1];
  if (number === undefined)
    throw new Error(`${path}: migration filename must start with a number.`);
  return BigInt(number);
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
    try {
      git("merge-base", "--is-ancestor", explicitBase, "HEAD");
    } catch {
      throw new Error(`MADORI_MIGRATION_BASE ${explicitBase} is not in the history of HEAD.`);
    }
    return { commit: explicitBase, source: "MADORI_MIGRATION_BASE" };
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

function main() {
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

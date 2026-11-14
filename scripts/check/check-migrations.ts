import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const migrationsPath = "apps/worker/migrations/";

function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function migrationNumber(path: string) {
  const number = /^(\d+)/.exec(basename(path))?.[1];
  if (number === undefined)
    throw new Error(`${path}: migration filename must start with a number.`);
  return BigInt(number);
}

function main() {
  const head = git("rev-parse", "HEAD").trim();
  let mainHead: string;
  try {
    mainHead = git("rev-parse", "--verify", "refs/remotes/origin/main").trim();
  } catch {
    throw new Error("Migration check needs origin/main and full history. Fetch origin/main first.");
  }
  const branch = git("branch", "--show-current").trim();
  const onMain = branch === "main" || (branch === "" && head === mainHead);
  const base = onMain
    ? git("rev-parse", "HEAD^1").trim()
    : git("merge-base", "HEAD", mainHead).trim();
  const baseline = new Set(
    git("ls-tree", "-r", "--name-only", "-z", base, "--", migrationsPath)
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
    base,
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
  if (violations.length > 0) throw new Error(violations.join("\n"));
  console.log(`Migration immutability check passed (base ${base}).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

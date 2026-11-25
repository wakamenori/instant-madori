import { execFileSync, spawnSync } from "node:child_process";

const workflow = ".github/workflows/deploy-staging.yml";
const sha = /^[a-f0-9]{40}$/;
class UsageError extends Error {}

function request([kind, pr, head, ...extra]) {
  if (/^[1-9][0-9]*$/.test(pr) && extra.length === 0) {
    if (kind === "before" && sha.test(head)) return { kind, pr, head };
    if (kind === "after" && head === undefined) return { kind, pr };
  }
  throw new UsageError("usage: deploy-files.mjs before <PR> <head> | after <PR>");
}

export function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: "pipe", maxBuffer: 64 << 20 });
}

function compare(request) {
  const { pr } = request;
  if (request.kind === "before") {
    const { head } = request;
    git("fetch", "-q", "origin", "main", `pull/${pr}/head`);
    const result = spawnSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], {
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status === 0) throw new Error(`${head} is already in origin/main. Use after ${pr}`);
    if (result.status !== 1) throw new Error(result.stderr.trim() || "git merge-base failed");
    return { range: [`origin/main...${head}`], listFrom: "origin/main", merge: null };
  }
  const response = JSON.parse(
    execFileSync("gh", ["pr", "view", pr, "--json", "mergeCommit"], {
      encoding: "utf8",
      stdio: "pipe",
    }),
  );
  if (response?.mergeCommit === null) throw new Error(`PR #${pr} is not merged`);
  const merge = response?.mergeCommit?.oid;
  if (typeof merge !== "string" || !sha.test(merge)) throw new Error("invalid mergeCommit from gh");
  git("fetch", "-q", "origin", "main");
  return { range: [`${merge}^1`, merge], listFrom: merge, merge };
}

function pathsIgnore(text) {
  const patterns = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (!inside) inside = line === "    paths-ignore:";
    else if (/^ {0,5}[^ #]/.test(line)) inside = false;
    else {
      const entry = /^      - "(.*)"$/.exec(line);
      if (entry) patterns.push(entry[1]);
    }
  }
  return patterns;
}

export function deployingFiles(listFrom, range, label = "deploy-files") {
  const spec = `${listFrom}:${workflow}`;
  let text = "";
  try {
    text = git("show", spec);
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error;
  }
  const patterns = pathsIgnore(text);
  const files = git(
    "diff",
    "--no-renames",
    "-z",
    "--name-only",
    ...range,
    "--",
    ":/",
    ...patterns.map((pattern) => `:(top,glob,exclude)${pattern}`),
  );
  if (!patterns.length)
    console.error(
      `${label}: cannot read paths-ignore from ${spec}. Every changed file counts as deploying.`,
    );
  return files;
}

function main() {
  const { range, listFrom, merge } = compare(request(process.argv.slice(2)));
  const files = deployingFiles(listFrom, range);
  if (files && merge) console.error(`merge commit ${merge}`);
  if (files) process.stdout.write(files.replaceAll("\0", "\n"));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`deploy-files: ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

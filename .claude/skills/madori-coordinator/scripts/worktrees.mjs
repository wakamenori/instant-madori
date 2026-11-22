import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

class UsageError extends Error {}
const hour = 3600000;

function request([command, ...args]) {
  if (command === "agent" && args.length === 1 && isAbsolute(args[0]))
    return { command, path: args[0] };
  if (command === "sweep") {
    if (args.length === 1 && args[0] === "--keep-none") return { command, keep: [] };
    if (
      args.length &&
      args.length % 2 === 0 &&
      args.every((arg, i) => (i % 2 === 0 ? arg === "--keep" : isAbsolute(arg)))
    )
      return { command, keep: args.filter((_, i) => i % 2 === 1) };
  }
  throw new UsageError(
    "usage: worktrees.mjs agent <absolute path> | sweep (--keep <absolute path> ... | --keep-none)",
  );
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 << 20,
  });
}

function canonical(path) {
  return existsSync(path) ? realpathSync(path) : path;
}

function inventory(main) {
  const agents = canonical(join(main, ".claude/worktrees"));
  const t3 = canonical(join(homedir(), ".t3/worktrees/instant-madori"));
  return git(main, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter(Boolean)
    .map((record, index) => {
      const fields = new Map(
        record.split("\0").map((field) => {
          const space = field.indexOf(" ");
          return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
        }),
      );
      const path = fields.get("worktree");
      let kind = "unmanaged";
      if (index > 0 && !fields.has("prunable")) {
        if (dirname(path) === agents && /^agent-[0-9a-z]+$/.test(basename(path))) kind = "agent";
        else if (dirname(path) === t3) kind = "t3";
      }
      return {
        path,
        kind,
        head: fields.get("HEAD"),
        branch: fields.get("branch") ?? null,
        lock: fields.get("locked") ?? null,
        prunable: fields.has("prunable"),
      };
    });
}

function lockState(reason) {
  if (reason === null) return { kind: "none" };
  const match = /^claude agent \S+ \(pid (\d+)\b/.exec(reason);
  if (!match) return { kind: "foreign", reason };
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { kind: "stale", pid };
    if (error.code !== "EPERM") throw error;
  }
  return { kind: "live", pid };
}

function age(path) {
  const admin = git(path, "rev-parse", "--path-format=absolute", "--git-dir").trimEnd();
  return Math.max(0, Date.now() - statSync(join(admin, "commondir")).mtimeMs);
}

function agentDecision(lock, ageMs, minAge) {
  if (lock.kind === "live") return { keep: `running (pid ${lock.pid})` };
  if (lock.kind === "foreign") return { keep: `locked: ${lock.reason}` };
  if (ageMs < minAge) return { keep: `created ${Math.floor(ageMs / hour)}h ago` };
  return { unlock: lock.kind === "stale" };
}

function status(path) {
  return git(path, "status", "--porcelain", "--untracked-files=all");
}

function onRemote(main, head) {
  return Boolean(git(main, "for-each-ref", "--count=1", "--contains", head, "refs/remotes/"));
}

function message(error) {
  return (error.stderr || error.message).split("\n")[0];
}

function t3Facts(main, tree, keep) {
  const facts = { listed: keep.has(tree.path), locked: tree.lock !== null };
  if (facts.listed) return facts;
  facts.ageMs = age(tree.path);
  if (facts.ageMs < hour || facts.locked) return facts;
  facts.dirty = Boolean(status(tree.path));
  if (facts.dirty) return facts;
  facts.onRemote = onRemote(main, tree.head);
  if (facts.onRemote && tree.branch === null) {
    try {
      const history = git(tree.path, "log", "-g", "--format=%H", "HEAD")
        .split("\n")
        .filter(Boolean);
      facts.localHistory =
        history.length > 0 &&
        Boolean(git(main, "rev-list", "--max-count=1", ...new Set(history), "--not", "--remotes"));
    } catch (error) {
      facts.historyError = message(error);
    }
  }
  return facts;
}

function t3Decision(facts) {
  if (facts.listed) return { keep: "listed" };
  if (facts.ageMs < hour) return { keep: `created ${Math.floor(facts.ageMs / 60000)}m ago` };
  if (facts.locked) return { keep: "locked" };
  if (facts.dirty) return { keep: "uncommitted changes" };
  if (!facts.onRemote) return { keep: "HEAD not on origin" };
  if (facts.historyError) return { keep: facts.historyError };
  if (facts.localHistory) return { keep: "commits only in HEAD history" };
  return {};
}

function removeAgent(main, tree, unlock) {
  const { path } = tree;
  for (const line of status(path).split("\n").filter(Boolean))
    console.error(`discard ${path}: ${line}`);
  if (unlock) {
    // An earlier removal may have taken long enough for another agent to take the lock.
    const current = inventory(main).find((entry) => entry.path === path);
    if (current?.lock !== tree.lock || lockState(current.lock).kind !== "stale")
      throw new Error("worktree lock changed");
    git(main, "worktree", "unlock", path);
  }
  git(main, "worktree", "remove", "--force", path);
  const branch = `worktree-${basename(path)}`;
  const tip = git(main, "for-each-ref", "--format=%(objectname) %(refname)", `refs/heads/${branch}`)
    .split("\n")
    .find((line) => line.endsWith(` refs/heads/${branch}`));
  if (!tip) return;
  if (!onRemote(main, tip.split(" ")[0])) return `kept branch ${branch}: commits not on origin`;
  git(main, "branch", "-D", branch);
}

function run(main, tree, decision, sweep) {
  const { path } = tree;
  const report = sweep ? console.log : console.error;
  if (decision.keep !== undefined) {
    report(`kept ${path}: ${decision.keep}`);
    return sweep;
  }
  try {
    let branchMessage;
    if (tree.kind === "agent") branchMessage = removeAgent(main, tree, decision.unlock);
    else {
      // Git checks dirtiness at removal, but a new clean commit can also be unpublished.
      const current = inventory(main).find((entry) => entry.path === path);
      if (current?.kind !== "t3") throw new Error("worktree registration changed");
      const checked = t3Decision(t3Facts(main, current, new Set()));
      if (checked.keep !== undefined) {
        report(`kept ${path}: ${checked.keep}`);
        return true;
      }
      git(main, "-c", "status.showUntrackedFiles=all", "worktree", "remove", path);
    }
    console.log(`removed ${path}`);
    if (branchMessage) console.log(branchMessage);
    return true;
  } catch (error) {
    report(`failed ${path}: ${message(error)}`);
    return false;
  }
}

function main() {
  const args = request(process.argv.slice(2));
  const root = dirname(
    git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir").trimEnd(),
  );
  const trees = inventory(root);
  if (args.command === "agent") {
    const path = canonical(args.path);
    const tree = trees.find((t) => t.path === path && !t.prunable);
    if (!tree && !existsSync(path)) {
      console.log(`absent ${args.path}`);
      return;
    }
    if (tree?.kind !== "agent") {
      console.error(
        `kept ${args.path}: ${tree ? "not a Claude Code agent worktree" : "not a registered worktree"}`,
      );
      process.exitCode = 1;
    } else if (!run(root, tree, agentDecision(lockState(tree.lock), 0, 0), false))
      process.exitCode = 1;
    return;
  }

  const keep = new Set();
  for (const input of args.keep) {
    const path = canonical(input);
    if (trees.some((t) => t.path === path && !t.prunable)) keep.add(path);
    else {
      console.error(
        `worktrees: --keep ${input} is not a worktree (${existsSync(path) ? "exists but is not a registered worktree" : "does not exist"})`,
      );
      process.exitCode = 2;
    }
  }
  if (process.exitCode) return;
  const managed = trees
    .filter((t) => t.kind !== "unmanaged")
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "agent" ? -1 : 1) : a.path < b.path ? -1 : 1));
  const plans = managed.map((tree) =>
    tree.kind === "agent"
      ? agentDecision(lockState(tree.lock), age(tree.path), 24 * hour)
      : t3Decision(t3Facts(root, tree, keep)),
  );
  for (const [i, tree] of managed.entries()) {
    if (!run(root, tree, plans[i], true)) process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`worktrees: ${message(error)}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

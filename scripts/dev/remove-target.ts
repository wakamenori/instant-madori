import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { freeBytesOnThisMac, tryLock } from "../shared/docker-slots.ts";

const entries = ["scripts/check/check.ts", "scripts/dev/dev.ts"] as const;
type Entry = { kind: "entry"; pid: number; script: (typeof entries)[number] };
type Keep =
  | Entry
  | { kind: "cargo-lock"; lock: string }
  | { kind: "not-directory" }
  | { kind: "platform"; platform: string }
  | { kind: "git"; detail: string };
type ProcessRow = { pid: number; executable: string; args: string; cwd: string | undefined };

const valueOptions = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--conditions",
  "-C",
  "--title",
  "--inspect-port",
]);

function scriptAndArgs({ executable, args }: ProcessRow) {
  const prefix = args.startsWith(executable + " ") ? executable : args.match(/^\S+/u)?.[0];
  if (!prefix) return "";
  let rest = args.slice(prefix.length).trimStart();
  while (rest.startsWith("-")) {
    const option = rest.split(/\s/u, 1)[0] ?? "";
    rest = rest.slice(option.length).trimStart();
    if (option === "--") break;
    if (/^(?:-[ep]|--(?:eval|print)(?:=|$))/u.test(option)) return "";
    if (valueOptions.has(option)) rest = rest.replace(/^\S+\s*/u, "");
  }
  return rest;
}

export function entryHolders(rows: ProcessRow[], root: string, ownPid: number): Entry[] {
  const holders: Entry[] = [];
  for (const row of rows) {
    if (row.pid === ownPid || basename(row.executable) !== "node") continue;
    const rest = scriptAndArgs(row);
    for (const script of entries) {
      const absolute = join(root, script);
      const paths = [absolute];
      if (row.cwd) {
        const local = relative(row.cwd, absolute);
        paths.push(local, "./" + local);
      }
      if (paths.some((path) => rest === path || rest.startsWith(path + " "))) {
        holders.push({ kind: "entry", pid: row.pid, script });
      }
    }
  }
  return holders;
}

const pidSchema = z.coerce.number().int().positive();
function psFields(column: "comm" | "args", selection: string[]) {
  const output = execFileSync("ps", [...selection, "-ww", "-o", "pid=," + column + "="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 ** 2,
  });
  return output
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [, pid, field] = z
        .tuple([z.string(), z.string(), z.string()])
        .parse(/^\s*(\d+)\s+(.*)$/u.exec(line));
      return { pid: pidSchema.parse(pid), field };
    });
}

function currentHolders(root: string) {
  const nodes = psFields("comm", ["-A"]).filter(
    ({ pid, field }) => pid !== process.pid && basename(field) === "node",
  );
  if (!nodes.length) return [];
  const ids = nodes.map(({ pid }) => pid).join(",");
  const args = new Map(psFields("args", ["-p", ids]).map(({ pid, field }) => [pid, field]));
  const result = spawnSync("lsof", ["-a", "-d", "cwd", "-p", ids, "-Fpn"], { encoding: "utf8" });
  // lsof also returns 1 when a selected process exits during enumeration.
  if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr.trim()) {
    throw new Error("Could not inspect node working directories");
  }
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const field = z
      .string()
      .regex(/^(?:p\d+|fcwd|n.+)$/u)
      .parse(line);
    if (field.startsWith("p")) pid = pidSchema.parse(field.slice(1));
    else if (field.startsWith("n") && pid !== undefined) cwds.set(pid, field.slice(1));
  }
  return entryHolders(
    nodes.map(({ pid, field }) => ({
      pid,
      executable: field,
      args: args.get(pid) ?? "",
      cwd: cwds.get(pid),
    })),
    root,
    process.pid,
  );
}

function lockCargo(directory: string, depth: number, descriptors: number[], reasons: Keep[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (depth < 3 && entry.isDirectory()) lockCargo(path, depth + 1, descriptors, reasons);
    if (depth >= 2 && entry.isFile() && /^\.cargo-[a-z-]*lock$/u.test(entry.name)) {
      const fd = tryLock(path);
      if (fd === undefined) reasons.push({ kind: "cargo-lock", lock: path });
      else descriptors.push(fd);
    }
  }
}

function keep(reasons: Keep[]) {
  for (const reason of reasons) console.error(Object.values(reason).join(" "));
  return 1;
}

function freeGiB() {
  return (freeBytesOnThisMac() / 1024 ** 3).toFixed(1) + " GiB";
}

function main() {
  if (process.platform !== "darwin")
    return keep([{ kind: "platform", platform: process.platform }]);
  const root = realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).replace(/\n$/u, ""),
  );
  const target = join(root, "target");
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    console.log("no target/");
    return 0;
  }
  const reasons: Keep[] = [];
  if (!stat.isDirectory()) reasons.push({ kind: "not-directory" });
  if (spawnSync("git", ["check-ignore", "-q", "target"], { cwd: root }).status !== 0) {
    reasons.push({ kind: "git", detail: "target is not ignored" });
  }
  if (execFileSync("git", ["ls-files", "--", "target"], { cwd: root }).length) {
    reasons.push({ kind: "git", detail: "target contains tracked files" });
  }
  const descriptors: number[] = [];
  try {
    if (stat.isDirectory()) lockCargo(target, 1, descriptors, reasons);
    reasons.push(...currentHolders(root));
    if (reasons.length) return keep(reasons);
    const before = freeGiB();
    rmSync(target, { recursive: true });
    console.log(`removed target/: free ${before} -> ${freeGiB()}`);
    return 0;
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof z.ZodError ? "Invalid process list" : String(error));
    process.exitCode = 1;
  }
}

import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { freeBytesOnThisMac, tryLock } from "../shared/docker-slots.ts";

const GiB = 1024 ** 3;
export const capBytes = 16 * GiB;
const floorBytes = 20 * GiB;
export const quietMs = 24 * 3_600_000;

export type Heap =
  | { id: "main"; kind: "checkout"; target: string }
  | { id: `runner:${string}`; kind: "runner"; target: string; runnerRoot: string };
export type Measured = Heap & {
  bytes: number;
  newestWriteMs: number | undefined;
  oldestBirthMs: number | undefined;
};
export type Decision =
  | { heap: Measured; action: "over-cap" }
  | { heap: Measured; action: "low-disk" }
  | { heap: Measured; action: "keep"; reason: "empty" | "refilled-recently" };
export type Holder =
  | { kind: "cargo-lock"; lock: string }
  | { kind: "runner-job"; pid: number }
  | { kind: "process"; pid: number; command: string }
  | { kind: "recent-write"; at: string };

const runnerConfig = z.object({
  agentName: z.string().regex(/^[\w.-]{1,64}$/u),
  gitHubUrl: z.string(),
  workFolder: z.string().min(1),
});
export function parseRunnerConfig(text: string, runnerRoot: string): Heap | undefined {
  const { agentName, gitHubUrl, workFolder } = runnerConfig.parse(JSON.parse(text.trimStart()));
  if (gitHubUrl !== "https://github.com/wakamenori/instant-madori") return;
  return {
    id: `runner:${agentName}`,
    kind: "runner",
    runnerRoot,
    target: join(resolve(runnerRoot, workFolder), "_tool/madori/target"),
  };
}

type Process = { pid: number; command: string };
const processRow = z.tuple([z.coerce.number().int().nonnegative(), z.string().min(1)]);
export function parseProcesses(output: string): Process[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [pid, command] = processRow.parse(/^\s*(\d+)\s+(.+)$/u.exec(line)?.slice(1));
      return { pid, command };
    });
}

export function planReclaim(heaps: readonly Measured[], nowMs: number): Decision[] {
  const overCap: Decision[] = [];
  const lowDisk: Decision[] = [];
  const keep: Decision[] = [];
  for (const heap of heaps) {
    if (heap.bytes > capBytes) overCap.push({ heap, action: "over-cap" });
    else if (
      heap.bytes > 0 &&
      heap.oldestBirthMs !== undefined &&
      nowMs - heap.oldestBirthMs >= quietMs
    )
      lowDisk.push({ heap, action: "low-disk" });
    else
      keep.push({ heap, action: "keep", reason: heap.bytes === 0 ? "empty" : "refilled-recently" });
  }
  lowDisk.sort(
    (a, b) =>
      Number(b.heap.kind === "checkout") - Number(a.heap.kind === "checkout") ||
      b.heap.bytes - a.heap.bytes,
  );
  return [...overCap, ...lowDisk, ...keep];
}

export function findHolder(
  heap: Measured,
  processes: readonly Process[],
  nowMs: number,
  selfPid: number,
): Holder | undefined {
  if (heap.kind === "runner") {
    const worker = processes.find(
      (p) => p.pid !== selfPid && p.command.startsWith(join(heap.runnerRoot, "bin/Runner.Worker")),
    );
    if (worker) return { kind: "runner-job", pid: worker.pid };
  }
  const process = processes.find((p) => p.pid !== selfPid && p.command.includes(heap.target));
  if (process) return { kind: "process", ...process };
  if (
    heap.kind === "checkout" &&
    heap.newestWriteMs !== undefined &&
    nowMs - heap.newestWriteMs < quietMs
  )
    return { kind: "recent-write", at: new Date(heap.newestWriteMs).toISOString() };
  return undefined;
}

function discoverHeaps(): Heap[] {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trimEnd();
  const heaps: Heap[] = [{ kind: "checkout", id: "main", target: join(dirname(common), "target") }];
  const runners = join(userInfo().homedir, "actions-runner");
  if (!lstatSync(runners, { throwIfNoEntry: false })) return heaps;
  for (const entry of readdirSync(runners, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runnerRoot = join(runners, entry.name);
    const config = join(runnerRoot, ".runner");
    if (!lstatSync(config, { throwIfNoEntry: false })?.isFile()) continue;
    const heap = parseRunnerConfig(readFileSync(config, "utf8"), runnerRoot);
    if (heap) heaps.push(heap);
  }
  return heaps;
}

function isCargoLock(name: string, depth: number) {
  return (depth === 2 || depth === 3) && /^\.cargo-[a-z-]*lock$/u.test(name);
}

export function measure(heap: Heap, locks = new Set<string>()): Measured {
  const measured: Measured = {
    ...heap,
    bytes: 0,
    newestWriteMs: undefined,
    oldestBirthMs: undefined,
  };
  const root = lstatSync(heap.target, { throwIfNoEntry: false });
  if (!root) return measured;
  if (!root.isDirectory()) throw new Error(`Expected target directory at ${heap.target}`);
  const seen = new Set<string>();
  function walk(directory: string, depth: number) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path, { throwIfNoEntry: false, bigint: true });
      if (!stat) continue;
      if (stat.isDirectory()) walk(path, depth + 1);
      if (!stat.isFile()) continue;
      const key = `${stat.dev}:${stat.ino}`;
      if (!seen.has(key)) measured.bytes += Number(stat.blocks) * 512;
      seen.add(key);
      if (isCargoLock(name, depth)) {
        locks.add(path);
        continue;
      }
      measured.newestWriteMs = Math.max(
        measured.newestWriteMs ?? -Infinity,
        Number(stat.mtimeNs) / 1e6,
      );
      measured.oldestBirthMs = Math.min(
        measured.oldestBirthMs ?? Infinity,
        Number(stat.birthtimeNs) / 1e6,
      );
    }
  }
  walk(resolve(heap.target), 1);
  return measured;
}

function snapshotProcesses() {
  return parseProcesses(
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 ** 2 }),
  );
}

export async function claimAndEmpty(
  heap: Heap,
  processes: () => readonly Process[] | Promise<readonly Process[]> = snapshotProcesses,
): Promise<Holder | undefined> {
  const locks = new Set<string>();
  const measured = measure(heap, locks);
  const descriptors: number[] = [];
  try {
    for (const lock of locks) {
      const fd = tryLock(lock);
      if (fd === undefined) return { kind: "cargo-lock", lock };
      descriptors.push(fd);
    }
    const holder = findHolder(measured, await processes(), Date.now(), process.pid);
    if (holder) return holder;
    function empty(directory: string, depth: number): boolean {
      if (!lstatSync(directory).isDirectory())
        throw new Error(`Expected directory at ${directory}`);
      let retained = false;
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (locks.has(path)) {
          // Waiting Cargo processes must acquire the same inode when we release it.
          retained = true;
          continue;
        }
        const stat = lstatSync(path);
        if (isCargoLock(name, depth) && stat.isFile())
          throw new Error(`Cargo lock appeared during reclaim: ${path}`);
        if (depth < 3 && stat.isDirectory()) {
          if (empty(path, depth + 1)) retained = true;
          else rmdirSync(path);
        } else rmSync(path, { recursive: true });
      }
      return retained;
    }
    if (lstatSync(heap.target, { throwIfNoEntry: false })) empty(resolve(heap.target), 1);
    return undefined;
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info("Usage: node scripts/dev/prune-targets.ts [--dry-run]");
    return;
  }
  if (process.platform !== "darwin") {
    console.info(
      JSON.stringify({ event: "rust.targets.prune.skipped", platform: process.platform }),
    );
    return;
  }
  const decisions = planReclaim(
    discoverHeaps().map((heap) => measure(heap)),
    Date.now(),
  );
  console.info(
    JSON.stringify({
      event: "rust.targets.prune.plan",
      dryRun: values["dry-run"],
      capBytes,
      floorBytes,
      freeBytes: freeBytesOnThisMac(),
      heaps: decisions.map(({ heap, ...decision }) => ({
        id: heap.id,
        target: heap.target,
        bytes: heap.bytes,
        ...decision,
      })),
    }),
  );
  if (values["dry-run"]) return;
  for (const { heap, action } of decisions) {
    if (action === "keep") continue;
    const event = { event: "rust.targets.prune.heap", id: heap.id };
    const freeBefore = freeBytesOnThisMac();
    if (action === "low-disk" && freeBefore >= floorBytes) {
      console.info(JSON.stringify({ ...event, outcome: "skipped", reason: "free-enough" }));
      continue;
    }
    const holder = await claimAndEmpty(heap);
    console.info(
      JSON.stringify(
        holder
          ? { ...event, outcome: "busy", holder }
          : {
              ...event,
              outcome: "reclaimed",
              reason: action,
              freeBefore,
              freeAfter: freeBytesOnThisMac(),
            },
      ),
    );
  }
  const freeBytes = freeBytesOnThisMac();
  console.info(
    JSON.stringify({
      event: "rust.targets.prune.result",
      freeBytes,
      short: freeBytes < floorBytes,
    }),
  );
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Invalid runner configuration or process list"
        : error instanceof Error
          ? error.message.split("\n")[0]
          : "Rust target pruning failed",
    );
    process.exitCode = 1;
  }
}

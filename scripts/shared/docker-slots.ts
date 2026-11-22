import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { recordSlot } from "../../metrics/hook/docker-slot.ts";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { start, stop } from "./processes.ts";

const poolSizes = { development: 2, runner: 1 } as const;
export const minimumFreeBytes = 12 * 1024 ** 3;
export type DockerSlots =
  | { kind: "flock"; directory: string; pool: keyof typeof poolSizes; freeBytes: () => number }
  | { kind: "none"; platform: NodeJS.Platform };
const slots = Object.entries(poolSizes).flatMap(([pool, size]) =>
  Array.from({ length: size }, (_, i) => ({ pool, name: `${pool}-${i + 1}` })),
);
const home = userInfo().homedir;
function freeBytesOnThisMac() {
  const { bavail, bsize } = statfsSync(home);
  return bavail * bsize;
}
export function machineSlots(env = process.env, platform = process.platform): DockerSlots {
  if (platform !== "darwin") return { kind: "none", platform };
  return {
    kind: "flock",
    freeBytes: freeBytesOnThisMac,
    directory: join(home, ".local/state/instant-madori/docker-slots"),
    pool: env["GITHUB_ACTIONS"] === "true" ? "runner" : "development",
  };
}

const holder = z.object({
  pid: z.int().positive(),
  purpose: z.string(),
  cwd: z.string(),
  since: z.iso.datetime(),
});

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${s}s`;
}

function readHolder(path: string) {
  try {
    return holder.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function describe(directory: string, name: string, busy = false) {
  const record = readHolder(join(directory, name + ".lock"));
  if (!record || !isAlive(record.pid)) return `${name}: ${busy ? "held (starting)" : "free"}`;
  const { pid, purpose, cwd, since } = record;
  const path = cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
  return `${name}: ${purpose} (pid ${pid}, ${duration(Date.now() - Date.parse(since))}, ${path})`;
}

function tryLock(path: string) {
  // Darwin's O_EXLOCK is passed through by Node but absent from fs.constants.
  const O_EXLOCK = 0x20;
  try {
    return openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK,
      0o600,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
    )
      return;
    throw error;
  }
}

type SlotRequest = {
  purpose: string;
  signal: AbortSignal;
  log?: (line: string) => void;
  pace?: { pollMs: number; reportEveryMs: number };
};

function reporter(log: (line: string) => void) {
  return (message: string) =>
    log(`[docker-slot] ${new Date().toTimeString().slice(0, 8)} ${message}`);
}

function gib(bytes: number) {
  return `${(Math.floor((bytes / 1024 ** 3) * 10) / 10).toFixed(1)} GiB`;
}

function checkFreeDisk(
  config: Extract<DockerSlots, { kind: "flock" }>,
  when: string,
  report: (message: string) => void,
) {
  const free = config.freeBytes();
  if (free >= minimumFreeBytes) return;
  const reason = `${gib(free)} free, below ${gib(minimumFreeBytes)}`;
  report(
    `stopped ${when}: ${reason}. Nothing was deleted. Free disk space, then run it again. Agents: report to the coordinator and delete nothing outside your worktree.`,
  );
  throw new Error(`Not enough free disk space ${when} (${reason})`);
}

export function requireFreeDisk(
  config: DockerSlots,
  stage: string,
  log: (line: string) => void = console.log,
): void {
  if (config.kind === "flock") checkFreeDisk(config, `before ${stage}`, reporter(log));
}

export async function withDockerSlot<T>(
  config: DockerSlots,
  {
    purpose,
    signal,
    log = console.log,
    pace = { pollMs: 1000, reportEveryMs: 60000 },
  }: SlotRequest,
  work: (slotName: string | undefined) => Promise<T>,
): Promise<T> {
  const report = reporter(log);
  if (config.kind === "none") {
    report(`Docker slots work only on macOS; running without a slot on ${config.platform}`);
    return await work(undefined);
  }
  const { directory, pool } = config;
  const inherited = process.env["MADORI_DOCKER_SLOT"];
  if (inherited !== undefined)
    throw new Error(
      `Already inside Docker slot ${inherited}; do not wrap pnpm check --full or pnpm dev in docker-slots run`,
    );
  checkFreeDisk(config, `before taking a ${pool} slot for ${purpose}`, report);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const waitId = randomUUID();
  const cwd = process.cwd();
  recordSlot(waitId, "started", started, pool, cwd);
  let nextReport = started;
  while (!signal.aborted) {
    for (const slot of slots) {
      if (slot.pool !== pool) continue;
      const fd = tryLock(join(directory, slot.name + ".lock"));
      if (fd === undefined) continue;
      const acquired = Date.now();
      try {
        recordSlot(waitId, "acquired", acquired, pool, cwd);
        ftruncateSync(fd, 0);
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            purpose,
            cwd: process.cwd(),
            since: new Date(acquired).toISOString(),
          }),
        );
        const others = slots
          .filter((other) => other !== slot)
          .map((other) => describe(directory, other.name));
        report(`acquired ${slot.name} after ${duration(acquired - started)}. ${others.join("; ")}`);
        return await work(slot.name);
      } finally {
        try {
          ftruncateSync(fd, 0);
        } finally {
          closeSync(fd);
        }
        recordSlot(waitId, "released", Date.now(), pool, cwd);
        report(`released ${slot.name} after ${duration(Date.now() - acquired)}`);
      }
    }
    if (Date.now() >= nextReport) {
      const status = slots.map((slot) => describe(directory, slot.name, slot.pool === pool));
      report(`waiting ${duration(Date.now() - started)} for a ${pool} slot. ${status.join("; ")}`);
      nextReport = Date.now() + pace.reportEveryMs;
    }
    try {
      await sleep(pace.pollMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    if (!signal.aborted) {
      try {
        checkFreeDisk(
          config,
          `while waiting ${duration(Date.now() - started)} for a ${pool} slot for ${purpose}`,
          report,
        );
      } catch (error) {
        recordSlot(waitId, "cancelled", Date.now(), pool, cwd);
        throw error;
      }
    }
  }
  recordSlot(waitId, "cancelled", Date.now(), pool, cwd);
  report(`stopped waiting for a ${pool} slot`);
  throw signal.reason;
}

async function main(args: string[]) {
  const [action, separator, command, ...rest] = args;
  const config = machineSlots();
  if (action === "status" && args.length === 1) {
    if (config.kind === "none") console.log(`Docker slots work only on macOS (${config.platform})`);
    else for (const slot of slots) console.log(describe(config.directory, slot.name));
    return 0;
  }
  if (action !== "run" || separator !== "--" || !command) {
    console.error("Usage: node scripts/shared/docker-slots.ts status | run -- <command> [args...]");
    return 2;
  }
  const controller = new AbortController();
  let child: ReturnType<typeof start> | undefined;
  let stopping: Promise<void> | undefined;
  function interrupt() {
    if (controller.signal.aborted) return;
    controller.abort(new Error("Interrupted"));
    if (child) stopping = stop([child]);
  }
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    return await withDockerSlot(
      config,
      { purpose: [command, ...rest].join(" "), signal: controller.signal },
      async (name) => {
        child = start(
          command,
          rest,
          name === undefined ? {} : { env: { ...process.env, MADORI_DOCKER_SLOT: name } },
        );
        const result = await child.finished;
        await stopping;
        if (result.kind === "error") throw result.error;
        return result.code ?? 1;
      },
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

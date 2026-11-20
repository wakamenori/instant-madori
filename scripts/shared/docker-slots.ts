import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { start, stop } from "./processes.ts";

const poolSizes = { development: 2, runner: 1 } as const;
export type DockerSlots = { directory: string; pool: keyof typeof poolSizes };
const slots = Object.entries(poolSizes).flatMap(([pool, size]) =>
  Array.from({ length: size }, (_, i) => ({ pool, name: `${pool}-${i + 1}` })),
);
const home = userInfo().homedir;
export function machineSlots(env = process.env): DockerSlots {
  return {
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

function describe(directory: string, name: string, busy = false) {
  try {
    const parsed = holder.safeParse(
      JSON.parse(readFileSync(join(directory, name + ".lock"), "utf8")),
    );
    if (parsed.success) {
      const { pid, purpose, cwd, since } = parsed.data;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
      }
      const path = cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
      return `${name}: ${purpose} (pid ${pid}, ${duration(Date.now() - Date.parse(since))}, ${path})`;
    }
  } catch {
    /* A missing or partially written record cannot identify the holder. */
  }
  return `${name}: ${busy ? "held (starting)" : "free"}`;
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

export async function withDockerSlot<T>(
  { directory, pool }: DockerSlots,
  {
    purpose,
    signal,
    log = console.log,
    pace = { pollMs: 1000, reportEveryMs: 60000 },
  }: SlotRequest,
  work: (slotName: string) => Promise<T>,
): Promise<T> {
  const inherited = process.env["MADORI_DOCKER_SLOT"];
  if (inherited !== undefined)
    throw new Error(
      `Already inside Docker slot ${inherited}; do not wrap pnpm check --full or pnpm dev in docker-slots run`,
    );
  if (process.platform !== "darwin") throw new Error("Docker slots require macOS");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = Date.now();
  let nextReport = started;
  const report = (message: string) =>
    log(`[docker-slot] ${new Date().toTimeString().slice(0, 8)} ${message}`);
  while (!signal.aborted) {
    for (const slot of slots) {
      if (slot.pool !== pool) continue;
      const fd = tryLock(join(directory, slot.name + ".lock"));
      if (fd === undefined) continue;
      const acquired = Date.now();
      try {
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
  }
  report(`stopped waiting for a ${pool} slot`);
  throw signal.reason;
}

async function main(args: string[]) {
  const [action, separator, command, ...rest] = args;
  const config = machineSlots();
  if (action === "status" && args.length === 1) {
    for (const slot of slots) console.log(describe(config.directory, slot.name));
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
        child = start(command, rest, { env: { ...process.env, MADORI_DOCKER_SLOT: name } });
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

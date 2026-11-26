import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { constants } from "node:os";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";

export type ProcessOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error };

export function start(command: string, args: string[], options: SpawnOptions = {}) {
  // Keep child CLIs from putting the shared terminal into raw mode and consuming Ctrl-C.
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
    ...options,
  });
  const finished = new Promise<ProcessOutcome>((resolve) => {
    child.once("error", (error) => resolve({ kind: "error", error }));
    child.once("exit", (code, signal) => resolve({ kind: "exit", code, signal }));
  });
  return { child, finished };
}

export type Run = ReturnType<typeof start>;

const stopGraceMs = 5000;
// Escalate before stop() can kill the tether itself.
const tetherGraceMs = stopGraceMs - 1000;

export function startTethered(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Run {
  return start(
    process.execPath,
    [import.meta.filename, String(process.pid), command, ...args],
    options,
  );
}

export function groupHasLiveMember(group: number): boolean {
  const rows = execFileSync("ps", ["-A", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
  return rows.split("\n").some((row) => {
    const [pgid, stat] = row.trim().split(/\s+/);
    return Number(pgid) === group && !stat?.startsWith("Z");
  });
}

export function killGroup(group: number) {
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error;
    if (error.code === "ESRCH") return;
    // macOS returns EPERM when only zombies remain in the group.
    if (error.code === "EPERM" && !groupHasLiveMember(group)) return;
    throw error;
  }
}

if (import.meta.main) {
  const [parent, command, ...args] = process.argv.slice(2);
  const spawner = Number(parent);
  if (!Number.isSafeInteger(spawner) || spawner <= 1 || !command) {
    console.error("Usage: processes.ts <spawner-pid> <command> [args...]");
    process.exit(2);
  }
  if (process.ppid !== spawner) process.exit(1);

  const sweep = () => {
    if (!server.child.pid) return;
    killGroup(server.child.pid);
  };
  let escalation: NodeJS.Timeout | undefined;
  const release = () => {
    if (escalation) return;
    // Wrangler owns Container disposal. Signalling workerd too races that cleanup.
    server.child.kill("SIGTERM");
    escalation = globalThis.setTimeout(sweep, tetherGraceMs).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, release);
  // A terminal signal during spawn must already belong to the release handler.
  const server = start(command, args, { stdio: "inherit" });
  const poll = setInterval(() => {
    if (process.ppid !== spawner) release();
  }, 250);
  const outcome = await server.finished;
  clearInterval(poll);
  clearTimeout(escalation);
  sweep();
  if (outcome.kind === "error") {
    console.error(outcome.error.message);
    process.exitCode = 127;
  } else {
    process.exitCode = outcome.signal ? 128 + constants.signals[outcome.signal] : outcome.code;
  }
}

export async function stop(processes: ReturnType<typeof start>[]) {
  const grace = setTimeout(stopGraceMs, undefined, { ref: false });
  async function signal({ child, finished }: ReturnType<typeof start>, name: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) child.kill(name);
      } else process.kill(-child.pid, name);
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ESRCH") return;
        if (error.code === "EPERM") {
          if (name === "SIGTERM") await Promise.race([finished, grace]);
          if (child.exitCode !== null || child.signalCode !== null) return;
        }
      }
      throw error;
    }
  }
  const failures: unknown[] = [];
  async function signalAll(runs: typeof processes, name: NodeJS.Signals) {
    const results = await Promise.allSettled(runs.map((run) => signal(run, name)));
    return runs.filter((_, index) => {
      const result = results[index];
      if (result?.status === "rejected") {
        failures.push(result.reason);
        return false;
      }
      return true;
    });
  }
  const terminated = await signalAll(processes, "SIGTERM");
  const done = Promise.all(terminated.map(({ finished }) => finished));
  await Promise.race([done, grace]);
  const killed = await signalAll(terminated, "SIGKILL");
  await Promise.all(killed.map(({ finished }) => finished));
  if (failures.length) throw failures[0];
}

/** Throws unless a finished child exited with status 0; `output` is appended if given. */
export function assertSucceeded(label: string, outcome: ProcessOutcome, output?: string) {
  if (outcome.kind === "error") throw outcome.error;
  if (outcome.code !== 0) {
    const status = outcome.signal ?? outcome.code ?? "unknown exit";
    throw new Error(`${label} failed (${status})${output === undefined ? "" : `:\n${output}`}`);
  }
}

/** Asks the OS for a free loopback port. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Polls `url` until it answers 2xx, failing early if `child` exits. */
export async function ready(url: string, child: ChildProcess, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server exited before ${url} was ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {
      /* The server may still be binding its port. */
    }
    await setTimeout(200);
  }
  throw new Error(`Server startup timed out: ${url}`);
}

/** Runs every teardown step, retaining failures in their original order. */
export async function cleanupSteps(actions: (() => void | Promise<void>)[]): Promise<unknown[]> {
  const problems: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      problems.push(error);
    }
  }
  return problems;
}

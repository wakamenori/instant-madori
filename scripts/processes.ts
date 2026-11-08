import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
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

export async function stop(processes: ReturnType<typeof start>[]) {
  function signal(child: ChildProcess, name: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) child.kill(name);
      } else process.kill(-child.pid, name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  for (const { child } of processes) signal(child, "SIGTERM");
  const done = Promise.all(processes.map(({ finished }) => finished));
  await Promise.race([done, setTimeout(5000, undefined, { ref: false })]);
  for (const { child } of processes) signal(child, "SIGKILL");
  await done;
}

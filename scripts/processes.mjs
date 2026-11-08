import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

export function start(command, args, options = {}) {
  // Keep child CLIs from putting the shared terminal into raw mode and consuming Ctrl-C.
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], detached: process.platform !== "win32", ...options });
  const finished = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, finished };
}

export async function stop(processes) {
  function signal(child, name) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) child.kill(name);
      }
      else process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (const { child } of processes) signal(child, "SIGTERM");
  const done = Promise.all(processes.map(({ finished }) => finished));
  await Promise.race([done, setTimeout(5000, undefined, { ref: false })]);
  for (const { child } of processes) signal(child, "SIGKILL");
  await done;
}

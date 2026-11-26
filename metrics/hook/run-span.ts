import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { metricsHome } from "../home.ts";
import { captureProject, publish } from "./spool.ts";

const [name, separator, command, ...argv] = process.argv.slice(2);
if (!command || separator !== "--" || !["check", "build", "setup"].includes(name ?? "")) {
  throw new Error("Usage: run-span.ts <check|build|setup> -- <command> [args...]");
}

const started = new Date();
const child = spawn(command, argv, { stdio: "inherit", detached: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // Shell chains may have a foreground grandchild holding resources.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  });
}
child.on("error", (error: NodeJS.ErrnoException) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = error.code === "ENOENT" ? 127 : 126;
});
child.on("close", (code, signal) => {
  const exit = process.exitCode === undefined ? code : Number(process.exitCode);
  process.exitCode = signal ? 128 + constants.signals[signal] : (exit ?? 1);
  try {
    if (process.env.GITHUB_ACTIONS !== undefined) return;
    const home = metricsHome(process.env);
    if (!existsSync(home.ready)) return;
    const id = randomUUID();
    const cwd = process.cwd();
    publish(home, `run-span-${id}.json`, {
      v: 1,
      id,
      name,
      // pnpm appends arguments after the node script or the sh -c script and its $0.
      args: argv.slice(command === "sh" && argv[0] === "-c" ? 3 : 1),
      started_at: started.toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: exit,
      signal,
      cwd,
      project: captureProject(cwd),
      thread: process.env.T3CODE_THREAD_ID ?? null,
    });
  } catch {
    // Metrics must never change the command's exit status.
  }
});

import { ensureDevAccess } from "./local-access.ts";
import { assertSucceeded, start, stop } from "./processes.ts";
import type { ProcessOutcome } from "./processes.ts";

const wrangler = "node_modules/wrangler/bin/wrangler.js";

// Installed before any child starts: children run in their own process groups, so Ctrl-C
// reaches only this script, which must stop whatever is running at that moment.
// `on`, not `once`: a second Ctrl-C during shutdown must not fall back to Node's default
// handling, which would exit at once and leave the children running.
let interrupted = false;
const interruption = new Promise<ProcessOutcome>((resolve) => {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      interrupted = true;
      resolve({ kind: "exit", code: 0, signal: null });
    });
});

/** Runs one setup step to completion, stopping it if the developer interrupts. */
async function setupStep(label: string, launch: () => ReturnType<typeof start>) {
  if (interrupted) return false;
  const child = launch();
  const outcome = await Promise.race([child.finished, interruption]);
  if (interrupted) {
    await stop([child]);
    return false;
  }
  assertSucceeded(label, outcome);
  return true;
}

// Local Access settings for the Worker (.dev.vars) and the key the Vite proxy signs with.
await ensureDevAccess();
// Bring the local D1 database (.wrangler/state) up to the latest migration.
const migrated = await setupStep("Local D1 migration", () =>
  start(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local"], {
    cwd: "apps/worker",
    env: { ...process.env, CI: "1" },
  }),
);

if (migrated) {
  const processes = [
    start("cargo", ["run", "--locked", "-p", "madori-geometry"]),
    start(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", "8787"], {
      cwd: "apps/worker",
    }),
    start(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
      { cwd: "apps/web" },
    ),
  ];
  console.log(
    "Web: http://127.0.0.1:5173 | Worker: http://127.0.0.1:8787 | Geometry: http://127.0.0.1:3001/healthz",
  );
  const result = await Promise.race([...processes.map(({ finished }) => finished), interruption]);
  // Decide the exit status before stopping: a Ctrl-C during shutdown must not hide a crash.
  const stoppedByUser = interrupted;
  await stop(processes);
  if (result.kind === "error") console.error(result.error);
  process.exitCode = stoppedByUser ? 0 : result.kind === "error" ? 1 : (result.code ?? 1);
}

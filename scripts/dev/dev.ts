import { finishDevelopment } from "./dev-session.ts";
import { ensureDevAccess } from "./local-access.ts";
import { assertSucceeded, start, stop } from "../shared/processes.ts";
import type { ProcessOutcome } from "../shared/processes.ts";

const jobTestHold = process.env["MADORI_DEV_JOB_TEST_HOLD"];
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
  console.info(
    "Geometry runs in Docker; the first amd64 image build takes several minutes. MADORI_DEV_CONTAINERS=0 disables containers.",
  );
  const processes = [
    start(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        "8787",
        ...(jobTestHold === undefined ? [] : ["--var", `JOB_TEST_HOLD:${jobTestHold}`]),
        ...(process.env["MADORI_DEV_CONTAINERS"] === "0" ? ["--enable-containers=false"] : []),
      ],
      {
        cwd: "apps/worker",
      },
    ),
    start(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
      { cwd: "apps/web" },
    ),
  ];
  console.log("Web: http://127.0.0.1:5173 | Worker: http://127.0.0.1:8787");
  const result = await Promise.race([...processes.map(({ finished }) => finished), interruption]);
  // Decide the exit status before stopping: a Ctrl-C during shutdown must not hide a crash.
  const stoppedByUser = interrupted;
  await finishDevelopment(result, stoppedByUser, () => stop(processes));
}

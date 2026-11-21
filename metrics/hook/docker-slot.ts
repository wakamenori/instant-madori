import { existsSync } from "node:fs";
import { metricsHome } from "../home.ts";
import { captureProject, publish } from "./spool.ts";

export function recordSlot(
  waitId: string,
  phase: "started" | "acquired" | "cancelled" | "released",
  at: number,
  pool: "runner" | "development",
  cwd: string,
) {
  try {
    const env = process.env;
    const home = metricsHome(env);
    if (!existsSync(home.ready)) return;
    publish(home, `docker-slot-${waitId}-${phase}.json`, {
      v: 1,
      wait_id: waitId,
      phase,
      pool,
      at: new Date(at).toISOString(),
      cwd,
      project: captureProject(cwd),
      ...(pool === "runner" && {
        repository: env.GITHUB_REPOSITORY,
        run_id: env.GITHUB_RUN_ID,
        run_attempt: env.GITHUB_RUN_ATTEMPT,
      }),
    });
  } catch {
    // Metrics must never interrupt the slot holder.
  }
}

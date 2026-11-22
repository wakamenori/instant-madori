/** Wrangler starts docker outside its process group and leaves it running on non-interactive exit. */
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./processes.ts";

const launcher = fileURLToPath(new URL("./docker-tether.sh", import.meta.url));

export function dockerTetherEnv(env: NodeJS.ProcessEnv) {
  const target = [env["MADORI_DOCKER_TETHER_TARGET"], env["WRANGLER_DOCKER_BIN"]].find(
    (bin) => bin && resolve(bin) !== launcher,
  );
  return {
    WRANGLER_DOCKER_BIN: launcher,
    MADORI_DOCKER_TETHER_NODE: process.execPath,
    MADORI_DOCKER_TETHER_TARGET: target ?? "docker",
  };
}

if (import.meta.main) {
  const [parent, ...args] = process.argv.slice(2);
  const spawner = Number(parent);
  const target = process.env["MADORI_DOCKER_TETHER_TARGET"];
  if (!Number.isSafeInteger(spawner) || spawner <= 0 || !target) {
    console.error(
      "Usage: set MADORI_DOCKER_TETHER_TARGET and run docker-tether.ts <spawner-pid> [docker args...]",
    );
    process.exit(2);
  }
  if (spawner === 1 || process.ppid !== spawner) process.exit(1);
  const { child, finished } = start(target, args, { stdio: "inherit", detached: false });
  const poll = setInterval(() => {
    if (process.ppid === spawner) return;
    clearInterval(poll);
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      child.kill("SIGTERM");
    }
  }, 250);
  const outcome = await finished;
  clearInterval(poll);
  if (outcome.kind === "error") {
    console.error(outcome.error.message);
    process.exitCode = 127;
  } else {
    process.exitCode = outcome.signal ? 128 + constants.signals[outcome.signal] : outcome.code;
  }
}

import { join } from "node:path";
import { homedir } from "node:os";
export function metricsHome(env: NodeJS.ProcessEnv) {
  const root =
    env.INSTANT_MADORI_METRICS_HOME ??
    join(homedir(), "Library/Application Support/instant-madori");
  return {
    root,
    database: join(root, "metrics.sqlite"),
    ready: join(root, "spool/ready"),
    tmp: join(root, "spool/tmp"),
  };
}

import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { metricsHome } from "../home.ts";
function captureProject(start: string) {
  let dir = realpathSync(start);
  while (true) {
    const git = join(dir, ".git");
    const stat = statSync(git, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return { dir, git: { kind: "directory" } };
    if (stat?.isFile()) return { dir, git: { kind: "file", text: readFileSync(git, "utf8") } };
    const parent = dirname(dir);
    if (dir === parent) return { dir: start, git: { kind: "missing" } };
    dir = parent;
  }
}
export function spool(env: NodeJS.ProcessEnv) {
  const home = metricsHome(env);
  if (!existsSync(home.ready)) return;
  const at = new Date(),
    id = randomUUID(),
    name = at.getTime() + "-" + id + ".json";
  const keys = [
    "T3CODE_THREAD_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_CHILD_SESSION",
  ];
  const record = {
    v: 1,
    id,
    at: at.toISOString(),
    stdin: readFileSync(0, "utf8"),
    project: captureProject(env.CLAUDE_PROJECT_DIR ?? process.cwd()),
    env: Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
  };
  writeFileSync(join(home.tmp, name), JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(join(home.tmp, name), join(home.ready, name));
}

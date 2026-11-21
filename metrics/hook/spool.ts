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
export function captureProject(start: string) {
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
function permissionInput(stdin: string) {
  const input: unknown = JSON.parse(stdin);
  if (!input || typeof input !== "object") throw new Error("Invalid permission hook input");
  const fields = [
    "hook_event_name",
    "cwd",
    "session_id",
    "tool_name",
    "prompt_id",
    "permission_mode",
  ];
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) => fields.includes(key) && typeof value === "string",
      ),
    ),
  );
}
export function spool(env: NodeJS.ProcessEnv, permission = false) {
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
  const stdin = readFileSync(0, "utf8");
  const record = {
    v: 1,
    id,
    at: at.toISOString(),
    stdin: permission ? permissionInput(stdin) : stdin,
    project: captureProject(env.CLAUDE_PROJECT_DIR ?? process.cwd()),
    env: Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
  };
  publish(home, name, record);
}
export function publish(home: ReturnType<typeof metricsHome>, name: string, record: object) {
  writeFileSync(join(home.tmp, name), JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(join(home.tmp, name), join(home.ready, name));
}

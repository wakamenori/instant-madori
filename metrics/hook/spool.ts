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
type HookInput = Record<string, unknown>;
function isObject(value: unknown): value is HookInput {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(input: HookInput, keys: string[]) {
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => keys.includes(key) && typeof value === "string"),
  );
}
function outputMtime(path: string | undefined) {
  try {
    return path ? statSync(path).mtime.toISOString() : null;
  } catch {
    return null;
  }
}
const reducers = new Map<string, (input: HookInput) => HookInput | null>([
  [
    "PermissionRequest",
    (input) =>
      strings(input, [
        "hook_event_name",
        "cwd",
        "session_id",
        "tool_name",
        "prompt_id",
        "permission_mode",
      ]),
  ],
  [
    "PostToolUse",
    (input) => {
      const response = input.tool_response;
      if (!isObject(response) || typeof response.backgroundTaskId !== "string") return null;
      return {
        ...strings(input, ["hook_event_name", "cwd", "session_id", "tool_name", "tool_use_id"]),
        background_task_id: response.backgroundTaskId,
      };
    },
  ],
  [
    "UserPromptSubmit",
    (input) => {
      const prompt = input.prompt;
      if (typeof prompt !== "string" || !prompt.startsWith("<task-notification>")) return input;
      const body = prompt.split("</task-notification>", 1)[0] ?? "";
      const header = body.split("<summary>", 1)[0] ?? "";
      const summary = /<summary>([\s\S]*?)<\/summary>/u.exec(body)?.[1] ?? "";
      const code = /exit code (\d+)\)?$/u.exec(summary)?.[1];
      return {
        ...input,
        task_notification: {
          task_id: /<task-id>([^<]*)<\/task-id>/u.exec(header)?.[1] ?? null,
          tool_use_id: /<tool-use-id>([^<]*)<\/tool-use-id>/u.exec(header)?.[1] ?? null,
          status: /<status>([^<]*)<\/status>/u.exec(header)?.[1] ?? null,
          exit_code: code === undefined ? null : Number(code),
          ended_at: outputMtime(/<output-file>([^<]*)<\/output-file>/u.exec(header)?.[1]),
        },
      };
    },
  ],
]);
function reduceStdin(stdin: string) {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return stdin;
  }
  if (!isObject(input) || typeof input.hook_event_name !== "string") return stdin;
  const reduce = reducers.get(input.hook_event_name);
  if (!reduce) return stdin;
  const result = reduce(input);
  return result === null ? null : JSON.stringify(result);
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
  const stdin = reduceStdin(readFileSync(0, "utf8"));
  if (stdin === null) return;
  const record = {
    v: 1,
    id,
    at: at.toISOString(),
    stdin,
    project: captureProject(env.CLAUDE_PROJECT_DIR ?? process.cwd()),
    env: Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
  };
  publish(home, name, record);
}
export function publish(home: ReturnType<typeof metricsHome>, name: string, record: object) {
  writeFileSync(join(home.tmp, name), JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(join(home.tmp, name), join(home.ready, name));
}

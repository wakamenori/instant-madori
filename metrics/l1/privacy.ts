import { z } from "zod";
import type { Json, Obj } from "./envelope.ts";

const toolInputAttributes: readonly string[] = ["tool_input", "tool_parameters", "arguments"];

/**
 * Tool input fields kept as strings: commands, and where a tool acted. Every other string in a
 * tool input becomes `[dropped <n> chars]`; numbers and booleans stay.
 */
const toolInputStringKeys: readonly string[] = [
  "command",
  "full_command",
  "bash_command",
  "cmd",
  "workdir",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "glob",
  "url",
  "skill",
  "subagent_type",
  "model",
  "mcp_server_name",
  "mcp_tool_name",
];

/** Known secret shapes, replaced in every kept string by `[redacted:<name>]`. */
const tokenShapes: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/gu },
  { name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/gu },
  { name: "openai", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu },
  { name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
  { name: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { name: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { name: "npm", pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu },
  { name: "bearer", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/giu },
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  },
  {
    name: "assignment",
    pattern: /\b(\w*(?:token|secret|password|api[_-]?key)\w*)(\s*[=:]\s*|\s+)("?)[^\s"']{8,}\3/giu,
  },
];

/** Longer strings keep their head and `…[cut <n> chars]`. Heredoc commands can carry whole files. */
const maxStringLength = 16_384;
export function object(value: Json | undefined): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function redact(text: string) {
  for (const { name, pattern } of tokenShapes)
    text = text.replace(pattern, "[redacted:" + name + "]");
  return text.length > maxStringLength ? text.slice(0, maxStringLength) + "…[cut]" : text;
}
function identity(key: string) {
  return /^(?:user\.|enduser\.)/u.test(key) || key === "host.name" || key === "organization.id";
}
function prose(key: string) {
  return (
    identity(key) ||
    [
      "prompt",
      "prompt_text",
      "response",
      "output",
      "last_assistant_message",
      "session_title",
    ].includes(key)
  );
}
function tool(value: Json, key: string): Json {
  if (typeof value === "string")
    return /^\[dropped \d+ chars\]$/u.test(value)
      ? value
      : toolInputStringKeys.includes(key)
        ? redact(value)
        : `[dropped ${value.length} chars]`;
  if (Array.isArray(value)) return value.map((v) => tool(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !identity(k))
        .map(([k, v]) => [k, tool(v, k)]),
    );
  return value;
}
function reduced(value: Json): Json {
  const text = object(value).stringValue;
  if (typeof text !== "string") return {};
  try {
    return { stringValue: JSON.stringify(tool(z.json().parse(JSON.parse(text)), "")) };
  } catch {
    return {
      stringValue: /^\[dropped \d+ chars\]$/u.test(text) ? text : `[dropped ${text.length} chars]`,
    };
  }
}
function walk(value: Json): Json {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value
      .filter((v) => {
        const k = object(v).key;
        return typeof k !== "string" || !prose(k);
      })
      .map(walk);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !prose(k))
        .map(([k, v]) => [
          k,
          k === "value" && typeof value.key === "string" && toolInputAttributes.includes(value.key)
            ? reduced(v)
            : walk(v),
        ]),
    );
  return value;
}
export function logPrivacy(payload: Obj) {
  const { body, ...record } = object(payload.log_record);
  const name = Array.isArray(record.attributes)
    ? record.attributes.map(object).find((a) => a.key === "event.name")?.value
    : undefined;
  const event = object(name).stringValue;
  const text = object(body).stringValue;
  if (
    typeof event === "string" &&
    /^[a-z][a-z0-9_.-]{0,127}$/u.test(event) &&
    (text === event || text === "claude_code." + event)
  )
    record.body = { stringValue: text };
  return telemetry({ ...payload, log_record: record });
}
export function telemetry(payload: Obj) {
  return object(walk(payload));
}
const markers = [
  "madori-coordinator",
  "madori-owner",
  "verify-madori",
  "指揮役",
  "担当",
  "検証役",
  "実装役",
  "相談役",
  "見回り",
  "合格",
  "不合格",
  "PASS",
  "FAIL",
] as const;
const digestSchema = z.object({
  v: z.literal(1),
  length: z.int().nonnegative(),
  lines: z.int().positive(),
  command: z
    .string()
    .regex(/^[a-z0-9:_-]+$/u)
    .nullable(),
  relay_from_thread: z.uuid().nullable(),
  leading_tag: z
    .string()
    .regex(/^[a-z-]+$/u)
    .nullable(),
  refs: z.array(z.int().nonnegative()),
  uuids: z.array(z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu)),
  markers: z.array(z.enum(markers)),
});
function digest(text: string) {
  const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu;
  // Stored digests pass through telemetry() again on every replay, so keep only values that
  // survive redaction and still match digestSchema.
  const stable = (value: string | undefined) =>
    value !== undefined && redact(value) === value ? value : null;
  const relay =
    /^\[T3 Code: the agent in T3 thread "([a-f0-9-]{36})" sent this message, not the user\.\]/iu.exec(
      text,
    )?.[1];
  return {
    v: 1 as const,
    length: text.length,
    lines: text.split("\n").length,
    command: stable(/^\/([a-z0-9:_-]+)(?:\s|$)/u.exec(text)?.[1]),
    leading_tag: stable(/^<([a-z-]+)>/u.exec(text)?.[1]),
    relay_from_thread: digestSchema.shape.relay_from_thread.safeParse(relay).data ?? null,
    refs: [
      ...new Set([...text.matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)/gu)].map((m) => Number(m[1]))),
    ]
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b),
    uuids: [...new Set(text.match(uuid) ?? [])].sort(),
    markers: markers.filter((k) =>
      /^[\w-]+$/u.test(k) ? new RegExp("\\b" + k + "\\b", "u").test(text) : text.includes(k),
    ),
  };
}
function pick(data: Obj, keys: string[]) {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([k, v]) => keys.includes(k) && (typeof v === "string" || typeof v === "boolean"),
    ),
  );
}
function addDigests(input: Obj, facts: Obj) {
  for (const key of ["prompt", "last_assistant_message"]) {
    const name = key + "_digest";
    if (typeof input[key] === "string") facts[name] = digest(input[key]);
    else {
      const stored = digestSchema.safeParse(input[name]);
      if (stored.success) facts[name] = stored.data;
    }
  }
}
export function hookPrivacy(p: Obj) {
  const input = object(p.input),
    facts: Obj = pick(input, [
      "hook_event_name",
      "session_id",
      "cwd",
      "transcript_path",
      "permission_mode",
      "prompt_id",
      "effort",
      "model",
      "agent_type",
      "source",
      "reason",
      "stop_hook_active",
    ]);
  addDigests(input, facts);
  for (const key of ["background_tasks", "session_crons"]) {
    const name = key + "_count";
    if (Array.isArray(input[key])) facts[name] = input[key].length;
    else if (
      typeof input[name] === "number" &&
      Number.isSafeInteger(input[name]) &&
      input[name] >= 0
    )
      facts[name] = input[name];
  }
  return telemetry({
    v: 1,
    ...pick(p, ["id", "at"]),
    project: p.project ?? null,
    env: pick(object(p.env), [
      "T3CODE_THREAD_ID",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_EFFORT",
      "CLAUDE_CODE_CHILD_SESSION",
    ]),
    input:
      input.hook_event_name === "PermissionRequest"
        ? pick(input, [
            "hook_event_name",
            "cwd",
            "session_id",
            "tool_name",
            "prompt_id",
            "permission_mode",
          ])
        : facts,
  });
}

/** Codex sends the whole patch as `command`; keep only the file header lines, not the file bodies. */
function patchPaths(value: Json): Json {
  const input = object(value);
  if (typeof input.command !== "string") return value;
  const header = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): /u;
  return {
    ...input,
    command: input.command
      .split("\n")
      .filter((line) => header.test(line))
      .join("\n"),
  };
}
export function codexHookPrivacy(p: Obj) {
  const input = object(p.input);
  const facts = pick(input, [
    "hook_event_name",
    "session_id",
    "turn_id",
    "cwd",
    "transcript_path",
    "model",
    "permission_mode",
    "source",
    "agent_id",
    "agent_type",
    "tool_name",
    "tool_use_id",
    "stop_hook_active",
  ]);
  addDigests(input, facts);
  if (input.tool_input !== undefined) {
    const reduced = tool(input.tool_input, "");
    facts.tool_input = input.tool_name === "apply_patch" ? patchPaths(reduced) : reduced;
  }
  return telemetry({
    v: 1,
    ...pick(p, ["id", "at"]),
    project: p.project ?? null,
    env: pick(object(p.env), ["T3CODE_THREAD_ID", "CODEX_THREAD_ID"]),
    input: facts,
  });
}

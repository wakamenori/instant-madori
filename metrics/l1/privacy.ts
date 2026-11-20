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
import { z } from "zod";
import type { Json, Obj } from "./envelope.ts";
export function object(value: Json | undefined): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function redact(text: string) {
  for (const { name, pattern } of tokenShapes)
    text = text.replace(pattern, "[redacted:" + name + "]");
  return text.length > maxStringLength ? text.slice(0, maxStringLength) + "…[cut]" : text;
}
function prose(key: string) {
  return (
    /^(?:user\.|enduser\.)/u.test(key) ||
    [
      "host.name",
      "organization.id",
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
    return toolInputStringKeys.includes(key) ? redact(value) : `[dropped ${value.length} chars]`;
  if (Array.isArray(value)) return value.map((v) => tool(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !prose(k))
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
    return { stringValue: `[dropped ${text.length} chars]` };
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
export function telemetry(payload: Obj) {
  return object(walk(payload));
}
function digest(text: string) {
  const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu;
  return {
    v: 1,
    length: text.length,
    lines: text.split("\n").length,
    command: /^\/([a-z0-9:_-]+)(?:\s|$)/u.exec(text)?.[1] ?? null,
    leading_tag: /^<([a-z-]+)>/u.exec(text)?.[1] ?? null,
    relay_from_thread:
      /^\[T3 Code: the agent in T3 thread "([a-f0-9-]{36})" sent this message, not the user\.\]/iu.exec(
        text,
      )?.[1] ?? null,
    refs: [
      ...new Set([...text.matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)/gu)].map((m) => Number(m[1]))),
    ].sort((a, b) => a - b),
    uuids: [...new Set(text.match(uuid) ?? [])].sort(),
    markers: [
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
    ].filter((k) => text.includes(k)),
  };
}
export function hookPrivacy(p: Obj) {
  const pick = (data: Obj, keys: string[]) =>
    Object.fromEntries(
      Object.entries(data).filter(
        ([k, v]) => keys.includes(k) && (typeof v === "string" || typeof v === "boolean"),
      ),
    );
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
  for (const key of ["prompt", "last_assistant_message"])
    if (typeof input[key] === "string") facts[key + "_digest"] = digest(input[key]);
  for (const key of ["background_tasks", "session_crons"])
    if (Array.isArray(input[key])) facts[key + "_count"] = input[key].length;
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
    input: facts,
  });
}

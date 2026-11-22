import { z } from "zod";
import { hash, type Obj } from "../l1/envelope.ts";
import type { Parsed } from "../l1/sources.ts";
import { commonDir, spool } from "./hook-record.ts";

const hook = z.object({
  hook_event_name: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
  ]),
  session_id: z.string().min(1).max(256),
});
export function parseCodexHook(bytes: Buffer, identity: string): Parsed {
  const out: Parsed = { records: [], rejects: [], drops: [] };
  let safeContent: Obj | null = null;
  try {
    const { stdin, ...envelope } = spool.parse(JSON.parse(bytes.toString()));
    if (commonDir(envelope.project) !== identity) {
      out.drops.push({ source: "codex.hook", reason: "foreign" });
      return out;
    }
    const input = z.record(z.string(), z.json()).parse(JSON.parse(stdin));
    safeContent = { ...envelope, input };
    const { session_id, hook_event_name } = hook.parse(input);
    out.records.push({
      source: "codex.hook",
      sourceVersion: "spool-1",
      scope: { kind: "gated", subject: "codex.conversation:" + session_id },
      naturalKey: [session_id, hook_event_name, envelope.id].join("/"),
      occurredAt: envelope.at,
      payload: safeContent,
    });
  } catch {
    out.rejects.push({
      source: "codex.hook",
      reason: "invalid_hook",
      unitHash: hash(bytes),
      content: safeContent,
    });
  }
  return out;
}

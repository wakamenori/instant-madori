import { z } from "zod";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { hash, type Obj } from "../l1/envelope.ts";
import type { Parsed } from "../l1/sources.ts";
const project = z.object({
  dir: z.string().refine(isAbsolute),
  git: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), text: z.string().regex(/^gitdir: [^\r\n]+\s*$/u) }),
    z.object({ kind: z.literal("directory") }),
    z.object({ kind: z.literal("missing") }),
  ]),
});
const spool = z.object({
  v: z.literal(1),
  id: z.uuid(),
  at: z.iso.datetime(),
  project,
  env: z.record(z.string(), z.string()),
  stdin: z.string(),
});
const hook = z.record(z.string(), z.json()).and(
  z.object({
    hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
    session_id: z.string().min(1).max(256),
  }),
);
function commonDir(p: z.infer<typeof project>) {
  if (p.git.kind === "directory") return join(p.dir, ".git");
  if (p.git.kind === "missing") return null;
  const dir = resolve(p.dir, p.git.text.slice(8).trim());
  return basename(dirname(dir)) === "worktrees" ? dirname(dirname(dir)) : dir;
}
export function parseHook(bytes: Buffer, identity: string): Parsed {
  const out: Parsed = { records: [], rejects: [], drops: [] };
  let safeContent: Obj | null = null;
  try {
    const r = spool.parse(JSON.parse(bytes.toString()));
    if (commonDir(r.project) !== identity) {
      out.drops.push({ source: "claude.hook", reason: "foreign" });
      return out;
    }
    const raw: unknown = JSON.parse(r.stdin);
    const fields = z.record(z.string(), z.json()).safeParse(raw);
    if (fields.success)
      safeContent = {
        v: r.v,
        id: r.id,
        at: r.at,
        project: r.project,
        env: r.env,
        input: fields.data,
      };
    const input = hook.parse(raw);
    out.records.push({
      source: "claude.hook",
      sourceVersion: "spool-1",
      scope: { kind: "proof", subject: "claude.session:" + input.session_id },
      naturalKey: [input.session_id, input.hook_event_name, r.id].join("/"),
      occurredAt: new Date(r.at).toISOString(),
      payload: { v: r.v, id: r.id, at: r.at, project: r.project, env: r.env, input },
    });
  } catch {
    out.rejects.push({
      source: "claude.hook",
      reason: "invalid_hook",
      unitHash: hash(bytes),
      content: safeContent,
    });
  }
  return out;
}

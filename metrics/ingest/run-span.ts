import { isAbsolute } from "node:path";
import { z } from "zod";
import { hash } from "../l1/envelope.ts";
import type { Parsed } from "../l1/sources.ts";
import { project, commonDir } from "./hook-record.ts";
import { candidate } from "./polled.ts";

const runSpan = z
  .object({
    v: z.literal(1),
    id: z.uuid(),
    name: z.enum(["check", "build", "setup"]),
    args: z.array(z.string()),
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    exit_code: z.int().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    cwd: z.string().refine(isAbsolute),
    thread: z.string().nullable(),
    project,
  })
  .refine((event) => (event.exit_code === null) !== (event.signal === null));

export function parseRunSpan(bytes: Buffer, identity: string): Parsed {
  const out: Parsed = { records: [], drops: [], rejects: [] };
  try {
    const { project, ...event } = runSpan.parse(JSON.parse(bytes.toString()));
    if (commonDir(project) !== identity) {
      out.drops.push({ source: "run.span", reason: "foreign" });
    } else {
      out.records.push(candidate("run.span", event.id, event.started_at, event));
    }
  } catch {
    out.rejects.push({
      source: "run.span",
      reason: "invalid_run_span",
      unitHash: hash(bytes),
      content: null,
    });
  }
  return out;
}

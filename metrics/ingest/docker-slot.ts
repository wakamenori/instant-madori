import { isAbsolute } from "node:path";
import { z } from "zod";
import { hash } from "../l1/envelope.ts";
import type { Parsed } from "../l1/sources.ts";
import { project, commonDir } from "./hook-record.ts";
import { candidate } from "./polled.ts";

const slot = z.object({
  v: z.literal(1),
  project,
  wait_id: z.uuid(),
  at: z.iso.datetime(),
  cwd: z.string().refine(isAbsolute),
  phase: z.enum(["started", "acquired", "cancelled", "released"]),
  pool: z.enum(["runner", "development"]),
  run_id: z.string().regex(/^\d+$/u).optional(),
  run_attempt: z.string().regex(/^\d+$/u).optional(),
  repository: z.string().optional(),
});
export function parseSlot(bytes: Buffer, identity: string): Parsed {
  const out: Parsed = { records: [], drops: [], rejects: [] };
  try {
    const { project, repository, ...event } = slot.parse(JSON.parse(bytes.toString()));
    if (
      commonDir(project) !== identity &&
      !(
        event.pool === "runner" &&
        repository === "wakamenori/instant-madori" &&
        event.run_id &&
        event.run_attempt
      )
    ) {
      out.drops.push({ source: "docker.slot", reason: "foreign" });
    } else {
      out.records.push(
        candidate("docker.slot", event.wait_id + "/" + event.phase, event.at, {
          ...event,
          run_id: event.run_id ?? null,
          run_attempt: event.run_attempt ?? null,
        }),
      );
    }
  } catch {
    out.rejects.push({
      source: "docker.slot",
      reason: "invalid_slot",
      unitHash: hash(bytes),
      content: null,
    });
  }
  return out;
}

import { activeJobStates } from "./job-states.ts";
import type { OwnerId } from "../owner.ts";
import { foundSchema, jsonRows, rows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { acceptedJobSchema, patternSchema, revisionSchema } from "@madori/contracts";
import type { AcceptedJob, Pattern, Revision } from "@madori/contracts";
import { patternJson } from "./patterns.ts";
import { snapshotJson, snapshotSchema } from "./snapshots.ts";
import type { Snapshot } from "./snapshots.ts";

export function revisionJson(t: string) {
  return `json_object('id', ${t}.id, 'patternId', ${t}.pattern_id,
    'number', ${t}.number, 'name', ${t}.name,
    'baseRevisionId', ${t}.base_revision_id, 'createdAt', ${t}.created_at)`;
}

export interface PatternState {
  pattern: Pattern;
  /** The revision with the greatest number, or null before the first commit. */
  currentRevision: Revision | null;
  runningJob: AcceptedJob | null;
  queuedJobs: AcceptedJob[];
}

// Keep jobs outermost so completed message history does not drive the queue scan.
export const queuedJobsSql = `SELECT json_object('jobId', j.id, 'messageId', m.id,
  'number', m.number) AS json
  FROM jobs j CROSS JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
  WHERE j.pattern_id = ? AND j.owner_id = ? AND j.state = 'queued'
  ORDER BY m.number`;

export const runningJobSql = `SELECT json_object('jobId', j.id, 'messageId', m.id,
  'number', m.number) AS json
  FROM jobs j INDEXED BY jobs_one_active_per_pattern
  CROSS JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
  WHERE j.pattern_id = ? AND j.owner_id = ? AND j.state IN (${activeJobStates})`;

export async function getPatternState(
  db: D1,
  scope: { ownerId: OwnerId; patternId: string },
): Promise<PatternState | null> {
  const [patterns, revisions, queuedJobs, runningJobs] = await db.batch([
    jsonRows(
      {
        sql: `SELECT ${patternJson("p")} AS json FROM patterns p WHERE p.id = ? AND p.owner_id = ?`,
        bindings: [scope.patternId, scope.ownerId],
      },
      patternSchema,
      "pattern",
    ),
    jsonRows(
      {
        sql: `SELECT ${revisionJson("r")} AS json FROM revisions r
      WHERE r.pattern_id = ? AND r.owner_id = ? ORDER BY r.number DESC LIMIT 1`,
        bindings: [scope.patternId, scope.ownerId],
      },
      revisionSchema,
      "revision",
    ),
    jsonRows(
      { sql: queuedJobsSql, bindings: [scope.patternId, scope.ownerId] },
      acceptedJobSchema,
      "queued job",
    ),
    jsonRows(
      { sql: runningJobSql, bindings: [scope.patternId, scope.ownerId] },
      acceptedJobSchema,
      "running job",
    ),
  ]);
  const pattern = patterns[0];
  if (!pattern) return null;
  return {
    pattern,
    currentRevision: revisions[0] ?? null,
    runningJob: runningJobs[0] ?? null,
    queuedJobs,
  };
}

export interface RevisionPage {
  revisions: Revision[];
  next: number | null;
}

export async function listRevisions(
  db: D1,
  query: { ownerId: OwnerId; patternId: string; after: number | null; limit: number },
): Promise<RevisionPage | null> {
  const [patterns, revisionRows] = await db.batch([
    rows(
      {
        sql: "SELECT 1 AS found FROM patterns WHERE id = ? AND owner_id = ?",
        bindings: [query.patternId, query.ownerId],
      },
      foundSchema,
      "existence",
    ),
    jsonRows(
      {
        sql: `SELECT ${revisionJson("r")} AS json FROM revisions r
      WHERE r.pattern_id = ? AND r.owner_id = ? AND (? IS NULL OR r.number < ?)
      ORDER BY r.number DESC LIMIT ?`,
        bindings: [query.patternId, query.ownerId, query.after, query.after, query.limit + 1],
      },
      revisionSchema,
      "revision",
    ),
  ]);
  if (patterns.length === 0) return null;
  const all = revisionRows;
  const revisions = all.slice(0, query.limit);
  return { revisions, next: all.length > query.limit ? (revisions.at(-1)?.number ?? null) : null };
}

export async function getRevisionSnapshot(
  db: D1,
  scope: { ownerId: OwnerId; revisionId: string },
): Promise<Snapshot | null> {
  return db.first(
    jsonRows(
      {
        sql: `SELECT ${snapshotJson("s")} AS json
    FROM snapshots s JOIN revisions r ON r.snapshot_id = s.id AND r.owner_id = s.owner_id
    WHERE r.id = ? AND r.owner_id = ? AND s.owner_id = ?`,
        bindings: [scope.revisionId, scope.ownerId, scope.ownerId],
      },
      snapshotSchema,
      "snapshot",
    ),
  );
}

import { patternSchema, revisionSchema } from "@madori/contracts";
import type { Pattern, Revision } from "@madori/contracts";
import { patternJson } from "./patterns.ts";
import { parseJsonColumn, parseJsonRows } from "./rows.ts";
import { snapshotJson, snapshotSchema } from "./snapshots.ts";
import type { Snapshot } from "./snapshots.ts";

function revisionJson(t: string) {
  return `json_object('id', ${t}.id, 'patternId', ${t}.pattern_id,
    'number', ${t}.number, 'name', ${t}.name,
    'baseRevisionId', ${t}.base_revision_id, 'createdAt', ${t}.created_at)`;
}

export type CommitResult = { kind: "committed"; revision: Revision } | { kind: "not_committed" };

export async function commitRevision(
  db: D1Database,
  input: {
    id: string;
    ownerId: string;
    patternId: string;
    name: string;
    baseRevisionId: string | null;
    snapshot: Snapshot;
  },
): Promise<CommitResult> {
  const s = input.snapshot;
  // The snapshot row is inserted under its own owner, so a mismatch would store an
  // unchecked row even though the revision insert refuses it.
  if (s.ownerId !== input.ownerId) throw new Error("Snapshot belongs to another owner");
  // Both inserts carry the base condition, so a reused snapshot ID cannot bypass it.
  const latestIsBase = `? IS (SELECT r.id FROM revisions r
    WHERE r.pattern_id = ? AND r.owner_id = ? ORDER BY r.number DESC LIMIT 1)`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO snapshots
      (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
      SELECT ?, ?, ?, ?, ?, ? FROM patterns p
      WHERE p.id = ? AND p.owner_id = ? AND ${latestIsBase}`,
      )
      .bind(
        s.id,
        s.ownerId,
        s.formatVersion,
        s.manifestKey,
        s.manifestSha256,
        s.createdAt,
        input.patternId,
        input.ownerId,
        input.baseRevisionId,
        input.patternId,
        input.ownerId,
      ),
    // A fresh snapshot ID's row ties this insert to the ownership condition above
    // without depending on connection-local changes().
    db
      .prepare(
        `INSERT INTO revisions
      (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at)
      SELECT ?, ?, s.owner_id,
        (SELECT coalesce(max(number), 0) + 1 FROM revisions
         WHERE pattern_id = ? AND owner_id = s.owner_id),
        ?, s.id, ?, s.created_at FROM snapshots s
      WHERE s.id = ? AND s.owner_id = ? AND ${latestIsBase}`,
      )
      .bind(
        input.id,
        input.patternId,
        input.patternId,
        input.name,
        input.baseRevisionId,
        s.id,
        input.ownerId,
        input.baseRevisionId,
        input.patternId,
        input.ownerId,
      ),
    db
      .prepare(
        `SELECT ${revisionJson("r")} AS json FROM revisions r WHERE r.id = ? AND r.owner_id = ?`,
      )
      .bind(input.id, input.ownerId),
  ]);
  const result = results[2];
  if (!result) throw new Error("D1 batch returned fewer results than statements");
  const revision = parseJsonRows(result.results, revisionSchema, "revision")[0];
  return revision ? { kind: "committed", revision } : { kind: "not_committed" };
}

export interface PatternState {
  pattern: Pattern;
  /** The revision with the greatest number, or null before the first commit. */
  currentRevision: Revision | null;
}

export async function getPatternState(
  db: D1Database,
  scope: { ownerId: string; patternId: string },
): Promise<PatternState | null> {
  const [patterns, revisions] = await db.batch([
    db
      .prepare(
        `SELECT ${patternJson("p")} AS json FROM patterns p WHERE p.id = ? AND p.owner_id = ?`,
      )
      .bind(scope.patternId, scope.ownerId),
    db
      .prepare(
        `SELECT ${revisionJson("r")} AS json FROM revisions r
      WHERE r.pattern_id = ? AND r.owner_id = ? ORDER BY r.number DESC LIMIT 1`,
      )
      .bind(scope.patternId, scope.ownerId),
  ]);
  if (!patterns || !revisions) throw new Error("D1 batch returned fewer results than statements");
  const pattern = parseJsonRows(patterns.results, patternSchema, "pattern")[0];
  if (!pattern) return null;
  return {
    pattern,
    currentRevision: parseJsonRows(revisions.results, revisionSchema, "revision")[0] ?? null,
  };
}

export interface RevisionPage {
  revisions: Revision[];
  next: number | null;
}

export async function listRevisions(
  db: D1Database,
  query: { ownerId: string; patternId: string; after: number | null; limit: number },
): Promise<RevisionPage | null> {
  const [patterns, rows] = await db.batch([
    db
      .prepare("SELECT 1 AS found FROM patterns WHERE id = ? AND owner_id = ?")
      .bind(query.patternId, query.ownerId),
    db
      .prepare(
        `SELECT ${revisionJson("r")} AS json FROM revisions r
      WHERE r.pattern_id = ? AND r.owner_id = ? AND (? IS NULL OR r.number < ?)
      ORDER BY r.number DESC LIMIT ?`,
      )
      .bind(query.patternId, query.ownerId, query.after, query.after, query.limit + 1),
  ]);
  if (!patterns || !rows) throw new Error("D1 batch returned fewer results than statements");
  if (patterns.results.length === 0) return null;
  const all = parseJsonRows(rows.results, revisionSchema, "revision");
  const revisions = all.slice(0, query.limit);
  return { revisions, next: all.length > query.limit ? (revisions.at(-1)?.number ?? null) : null };
}

export async function getRevisionSnapshot(
  db: D1Database,
  scope: { ownerId: string; revisionId: string },
): Promise<Snapshot | null> {
  const json = await db
    .prepare(
      `SELECT ${snapshotJson("s")} AS json
    FROM snapshots s JOIN revisions r ON r.snapshot_id = s.id AND r.owner_id = s.owner_id
    WHERE r.id = ? AND r.owner_id = ? AND s.owner_id = ?`,
    )
    .bind(scope.revisionId, scope.ownerId, scope.ownerId)
    .first("json");
  return json === null ? null : parseJsonColumn(json, snapshotSchema, "snapshot");
}

import type { OwnerId } from "../owner.ts";
import { foundSchema, jsonRows, rows, write } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { patternSchema, revisionSchema } from "@madori/contracts";
import type { Pattern, Revision } from "@madori/contracts";
import { patternJson } from "./patterns.ts";
import { snapshotJson, snapshotSchema } from "./snapshots.ts";
import type { Snapshot } from "./snapshots.ts";

function revisionJson(t: string) {
  return `json_object('id', ${t}.id, 'patternId', ${t}.pattern_id,
    'number', ${t}.number, 'name', ${t}.name,
    'baseRevisionId', ${t}.base_revision_id, 'createdAt', ${t}.created_at)`;
}

export type CommitResult = { kind: "committed"; revision: Revision } | { kind: "not_committed" };

export async function commitRevision(
  db: D1,
  input: {
    id: string;
    patternId: string;
    name: string;
    baseRevisionId: string | null;
    snapshot: Snapshot & { ownerId: OwnerId };
  },
): Promise<CommitResult> {
  const s = input.snapshot;
  // Both inserts carry the base condition, so a reused snapshot ID cannot bypass it.
  const latestIsBase = `? IS (SELECT r.id FROM revisions r
    WHERE r.pattern_id = ? AND r.owner_id = ? ORDER BY r.number DESC LIMIT 1)`;
  const [, , committed] = await db.batch([
    write({
      sql: `INSERT INTO snapshots
      (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
      SELECT ?, ?, ?, ?, ?, ? FROM patterns p
      WHERE p.id = ? AND p.owner_id = ? AND ${latestIsBase}`,
      bindings: [
        s.id,
        s.ownerId,
        s.formatVersion,
        s.manifestKey,
        s.manifestSha256,
        s.createdAt,
        input.patternId,
        s.ownerId,
        input.baseRevisionId,
        input.patternId,
        s.ownerId,
      ],
    }),
    // A fresh snapshot ID's row ties this insert to the ownership condition above
    // without depending on connection-local changes().
    write({
      sql: `INSERT INTO revisions
      (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at)
      SELECT ?, ?, s.owner_id,
        (SELECT coalesce(max(number), 0) + 1 FROM revisions
         WHERE pattern_id = ? AND owner_id = s.owner_id),
        ?, s.id, ?, s.created_at FROM snapshots s
      WHERE s.id = ? AND s.owner_id = ? AND ${latestIsBase}`,
      bindings: [
        input.id,
        input.patternId,
        input.patternId,
        input.name,
        input.baseRevisionId,
        s.id,
        s.ownerId,
        input.baseRevisionId,
        input.patternId,
        s.ownerId,
      ],
    }),
    jsonRows(
      {
        sql: `SELECT ${revisionJson("r")} AS json FROM revisions r WHERE r.id = ? AND r.owner_id = ?`,
        bindings: [input.id, s.ownerId],
      },
      revisionSchema,
      "revision",
    ),
  ]);
  const revision = committed[0];
  return revision ? { kind: "committed", revision } : { kind: "not_committed" };
}

export interface PatternState {
  pattern: Pattern;
  /** The revision with the greatest number, or null before the first commit. */
  currentRevision: Revision | null;
}

export async function getPatternState(
  db: D1,
  scope: { ownerId: OwnerId; patternId: string },
): Promise<PatternState | null> {
  const [patterns, revisions] = await db.batch([
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
  ]);
  const pattern = patterns[0];
  if (!pattern) return null;
  return {
    pattern,
    currentRevision: revisions[0] ?? null,
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
  const json = await db.first(
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
  return json;
}

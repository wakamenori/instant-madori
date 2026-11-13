import { patternSchema } from "@madori/contracts";
import type { Pattern } from "@madori/contracts";
import { z } from "zod";
import { mapOnce, recordStatement, runOnce, updateOnceStatements } from "./requests.ts";
import type { Once, RequestKey } from "./requests.ts";
import { parseJsonColumn, parseJsonRows } from "./rows.ts";

/**
 * The single mapping from a `patterns` row to `Pattern`. `t` is the table name or alias.
 * `fields` replaces columns with SQL expressions, to describe a row as it will be after an
 * update; their `?` placeholders appear in the order name, version, updatedAt.
 */
export function patternJson(
  t: string,
  fields: { name?: string; version?: string; updatedAt?: string } = {},
) {
  return `json_object('id', ${t}.id, 'projectId', ${t}.project_id,
    'name', ${fields.name ?? `${t}.name`}, 'version', ${fields.version ?? `${t}.version`},
    'createdAt', ${t}.created_at, 'updatedAt', ${fields.updatedAt ?? `${t}.updated_at`})`;
}

const patternResultSchema = z.object({ pattern: patternSchema });

export interface NewPattern {
  id: string;
  projectId: string;
  ownerId: string;
  /** Null gives the default name `${defaultNamePrefix}${number}`. */
  name: string | null;
  defaultNamePrefix: string;
  now: string;
}

/**
 * Two statements that add a pattern to an owned project: take the project's next pattern
 * number, then insert the pattern with it. Both carry the same ownership condition, so in
 * the batch's transaction either both apply or, for a missing or foreign project, neither
 * does. Numbers therefore have no gaps or duplicates.
 */
export function insertPatternStatements(db: D1Database, pattern: NewPattern) {
  // One condition for both statements, so they cannot drift apart.
  const owned = { sql: "id = ? AND owner_id = ?", bindings: [pattern.projectId, pattern.ownerId] };
  return [
    db
      .prepare(
        `UPDATE projects SET next_pattern_number = next_pattern_number + 1 WHERE ${owned.sql}`,
      )
      .bind(...owned.bindings),
    db
      .prepare(
        `INSERT INTO patterns
           (id, project_id, owner_id, number, name, version, created_at, updated_at)
         SELECT ?, id, owner_id, next_pattern_number - 1,
           coalesce(?, ? || (next_pattern_number - 1)), 1, ?, ?
         FROM projects
         WHERE ${owned.sql}`,
      )
      .bind(
        pattern.id,
        pattern.name,
        pattern.defaultNamePrefix,
        pattern.now,
        pattern.now,
        ...owned.bindings,
      ),
  ];
}

/**
 * Lists a project's patterns in number order, or returns null if the project is missing or
 * foreign. Both reads go in one batch: one round trip, one consistent snapshot.
 */
export async function listProjectPatterns(
  db: D1Database,
  scope: { ownerId: string; projectId: string },
): Promise<Pattern[] | null> {
  const [project, patterns] = await db.batch([
    db
      .prepare("SELECT 1 AS found FROM projects WHERE id = ? AND owner_id = ?")
      .bind(scope.projectId, scope.ownerId),
    db
      .prepare(
        `SELECT ${patternJson("t")} AS json FROM patterns t
         WHERE t.owner_id = ? AND t.project_id = ?
         ORDER BY t.number`,
      )
      .bind(scope.ownerId, scope.projectId),
  ]);
  if (!project || !patterns) throw new Error("D1 batch returned fewer results than statements");
  if (project.results.length === 0) return null;
  return parseJsonRows(patterns.results, patternSchema, "pattern");
}

export async function getPattern(
  db: D1Database,
  scope: { ownerId: string; patternId: string },
): Promise<Pattern | null> {
  const json = await db
    .prepare(`SELECT ${patternJson("t")} AS json FROM patterns t WHERE t.owner_id = ? AND t.id = ?`)
    .bind(scope.ownerId, scope.patternId)
    .first("json");
  return json === null ? null : parseJsonColumn(json, patternSchema, "pattern");
}

/** Adds a pattern once per request. `not_applied` means the project is missing or foreign. */
export async function createPatternOnce(
  db: D1Database,
  key: RequestKey,
  pattern: NewPattern,
): Promise<Once<Pattern>> {
  const record = recordStatement(db, key, pattern.now, {
    result: {
      sql: `SELECT json_object('pattern', ${patternJson("t")}) FROM patterns t WHERE t.id = ?`,
      bindings: [pattern.id],
    },
    // The pattern ID is new to this request, so its row exists only if the inserts applied.
    when: { sql: "SELECT 1 FROM patterns WHERE id = ?", bindings: [pattern.id] },
  });
  const once = await runOnce(
    db,
    key,
    patternResultSchema,
    [...insertPatternStatements(db, pattern), record],
    record,
  );
  return mapOnce(once, ({ pattern }) => pattern);
}

export interface PatternRename {
  ownerId: string;
  patternId: string;
  expectedVersion: number;
  name: string;
  now: string;
}

/** Renames once per request if the version matches. `not_applied`: missing, foreign or stale. */
export async function renamePatternOnce(
  db: D1Database,
  key: RequestKey,
  rename: PatternRename,
): Promise<Once<Pattern>> {
  const { record, statements } = updateOnceStatements(db, key, rename.now, {
    table: "patterns",
    set: {
      sql: "name = ?, version = version + 1, updated_at = ?",
      bindings: [rename.name, rename.now],
    },
    where: {
      sql: "id = ? AND owner_id = ? AND version = ?",
      bindings: [rename.patternId, rename.ownerId, rename.expectedVersion],
    },
    result: {
      sql: `SELECT json_object('pattern',
              ${patternJson("t", { name: "?", version: "t.version + 1", updatedAt: "?" })})
            FROM patterns t WHERE t.id = ?`,
      bindings: [rename.name, rename.now, rename.patternId],
    },
  });
  const once = await runOnce(db, key, patternResultSchema, statements, record);
  return mapOnce(once, ({ pattern }) => pattern);
}

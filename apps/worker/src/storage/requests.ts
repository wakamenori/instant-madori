import { z } from "zod";
import { parseJsonColumn, StorageCorruption } from "./rows.ts";

/** The row `recordStatement` returns. */
const recordedRowSchema = z.object({ result: z.string() });

/** A row of `requests` as `storedResult` reads it. */
const storedRowSchema = z.object({
  operation: z.string(),
  fingerprint: z.string(),
  result: z.string(),
});

/**
 * Identifies one mutating API request for replay. `operation` names what was asked
 * (e.g. "project.rename") and `fingerprint` hashes its target and normalized input, so the
 * same request ID cannot be reused for a different change.
 */
export interface RequestKey {
  ownerId: string;
  requestId: string;
  operation: string;
  fingerprint: string;
}

/**
 * Result of an operation that runs at most once per request ID.
 * - `applied`: this call made the change.
 * - `replayed`: an earlier call with the same request made it; its stored result is returned.
 * - `request_id_reused`: the ID was already used for a different operation or input.
 * - `not_applied`: the operation's condition did not hold; nothing was written or recorded,
 *   and the caller decides why (missing resource, stale version, ...).
 */
export type Once<T> =
  | { kind: "applied"; result: T }
  | { kind: "replayed"; result: T }
  | { kind: "request_id_reused" }
  | { kind: "not_applied" };

/** Transforms the result of `applied`/`replayed`, passing the other outcomes through. */
export function mapOnce<T, U>(once: Once<T>, transform: (result: T) => U): Once<U> {
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: once.kind, result: transform(once.result) };
    case "request_id_reused":
    case "not_applied":
      return once;
  }
}

async function storedResult<T>(
  db: D1Database,
  key: RequestKey,
  schema: z.ZodType<T>,
): Promise<Once<T> | null> {
  const found = await db
    .prepare(
      `SELECT operation, fingerprint, result FROM requests
       WHERE owner_id = ? AND request_id = ?`,
    )
    .bind(key.ownerId, key.requestId)
    .first();
  if (found === null) return null;
  const parsed = storedRowSchema.safeParse(found);
  if (!parsed.success) throw new StorageCorruption("request record");
  const row = parsed.data;
  if (row.operation !== key.operation || row.fingerprint !== key.fingerprint) {
    return { kind: "request_id_reused" };
  }
  return { kind: "replayed", result: parseJsonColumn(row.result, schema, key.operation) };
}

/** A piece of SQL with its `?` bindings in the order the placeholders appear. */
export interface SqlPart {
  sql: string;
  bindings: unknown[];
}

/**
 * The request record of a once-only batch, conditioned on the data, never on connection
 * state such as `changes()`. This relies only on what D1 documents: a batch is one
 * transaction whose statements run in order and see each other's writes, a failing
 * statement rolls back the whole batch, and a database processes one query at a time.
 *
 * - `when`: a query that has a row exactly when the operation applies. Placed after the
 *   writes it names their result (e.g. "the new row exists"); placed before them it states
 *   their precondition, and the writes then require the record (see `recordedBy`).
 * - `result`: a scalar query producing the result JSON. It must build the whole object in
 *   one `json_object` expression: SQLite drops the JSON subtype across subqueries, so
 *   nesting the results of separate subqueries would store strings.
 *
 * The statement returns the stored result, so the first response and every replay are the
 * same bytes. A second record for the same request ID fails on the primary key, which
 * rolls back the whole batch.
 */
export function recordStatement(
  db: D1Database,
  key: RequestKey,
  createdAt: string,
  parts: { result: SqlPart; when: SqlPart },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO requests (owner_id, request_id, operation, fingerprint, result, created_at)
       SELECT ?, ?, ?, ?, (${parts.result.sql}), ?
       WHERE EXISTS (${parts.when.sql})
       RETURNING result`,
    )
    .bind(
      key.ownerId,
      key.requestId,
      key.operation,
      key.fingerprint,
      ...parts.result.bindings,
      createdAt,
      ...parts.when.bindings,
    );
}

/** True while this exact request (ID, operation and fingerprint) is recorded. */
function recordedBy(key: RequestKey): SqlPart {
  return {
    sql: `EXISTS (SELECT 1 FROM requests
            WHERE owner_id = ? AND request_id = ? AND operation = ? AND fingerprint = ?)`,
    bindings: [key.ownerId, key.requestId, key.operation, key.fingerprint],
  };
}

/** Tables that once-only updates may change. Names are code constants, never input. */
export type UpdatableTable = "projects" | "patterns";

/**
 * The record-first protocol for a conditional update of rows in one table. `where` is the
 * update's whole precondition and is written once: the record requires it, and the update
 * requires both it and the record, so the two cannot drift apart.
 *
 * - When `where` holds, the record is inserted and the update applies.
 * - When it does not, neither happens, and `runOnce` then looks for a stored result.
 *
 * A request that was already recorded cannot apply twice. Usually the first update has
 * made `where` false (a rename bumps the version), so nothing is written and `runOnce`
 * returns the stored result. If `where` still holds, the record insert hits the primary
 * key and the whole batch rolls back. `where` is parenthesized wherever it is used, so a
 * top-level OR cannot split it differently in the two statements.
 *
 * `result` must describe the rows as the update will leave them (see the `fields`
 * parameter of the table's JSON mapping).
 */
export function updateOnceStatements(
  db: D1Database,
  key: RequestKey,
  createdAt: string,
  update: { table: UpdatableTable; set: SqlPart; where: SqlPart; result: SqlPart },
): { record: D1PreparedStatement; statements: D1PreparedStatement[] } {
  const record = recordStatement(db, key, createdAt, {
    result: update.result,
    when: {
      sql: `SELECT 1 FROM ${update.table} WHERE (${update.where.sql})`,
      bindings: update.where.bindings,
    },
  });
  const recorded = recordedBy(key);
  const statement = db
    .prepare(
      `UPDATE ${update.table} SET ${update.set.sql}
       WHERE (${update.where.sql}) AND ${recorded.sql}`,
    )
    .bind(...update.set.bindings, ...update.where.bindings, ...recorded.bindings);
  return { record, statements: [record, statement] };
}

/**
 * Runs a once-only operation: `statements` as one D1 batch (a transaction) that contains
 * `record`. This function only orders the checks around the batch; it cannot see whether
 * the statements are coupled correctly. Each operation designs its own SQL so that the
 * record exists exactly when the whole change happened, either through
 * `updateOnceStatements` or, for inserts, a record conditioned on the new rows.
 *
 * A request ID that already has a record can never apply twice: either its operation's
 * condition no longer holds and nothing is written, or the record insert hits the primary
 * key and the whole transaction rolls back. So the batch runs first, and the
 * stored result is read only when the batch failed or did not apply, which covers resends,
 * concurrent resends and reused IDs alike.
 */
export async function runOnce<T>(
  db: D1Database,
  key: RequestKey,
  schema: z.ZodType<T>,
  statements: D1PreparedStatement[],
  record: D1PreparedStatement,
): Promise<Once<T>> {
  const recordIndex = statements.indexOf(record);
  if (recordIndex === -1) throw new Error(`${key.operation}: the batch has no request record`);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    let stored: Once<T> | null;
    try {
      stored = await storedResult(db, key, schema);
    } catch (lookupError) {
      // Keep both causes; otherwise the lookup failure would hide why the batch failed.
      throw new AggregateError(
        [error, lookupError],
        `${key.operation}: batch failed and its stored result could not be read`,
        { cause: lookupError },
      );
    }
    if (stored) return stored;
    throw error;
  }
  const recorded: unknown = results[recordIndex]?.results[0];
  if (recorded !== undefined) {
    const row = recordedRowSchema.safeParse(recorded);
    if (!row.success) throw new StorageCorruption(key.operation);
    return { kind: "applied", result: parseJsonColumn(row.data.result, schema, key.operation) };
  }
  return (await storedResult(db, key, schema)) ?? { kind: "not_applied" };
}

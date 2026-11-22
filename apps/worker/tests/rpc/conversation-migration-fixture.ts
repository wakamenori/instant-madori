import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { conversationMessageSchema } from "@madori/contracts";
import {
  openJobDatabase,
  jobMigration,
  queueHoldMigration,
  conversationMigration,
  now,
} from "./jobs-support.ts";

const db = await openJobDatabase();
try {
  for (const migration of [jobMigration, queueHoldMigration])
    await db.apply(await readFile(migration, "utf8"));
  const ownerId = await db.owner("conversation-migration");
  const projectId = crypto.randomUUID();
  const first = crypto.randomUUID();
  const key = (operation: string) => ({
    ownerId,
    requestId: crypto.randomUUID(),
    fingerprint: "fixture",
    operation,
  });
  const project = await db.store.projects.createOnce(key("project.create"), {
    id: projectId,
    name: "P",
    now,
    firstPattern: { id: first, name: "T", defaultNamePrefix: "T" },
  });
  assert(project.kind === "applied");
  async function pattern() {
    const id = crypto.randomUUID();
    const result = await db.store.patterns.createOnce(key("pattern.create"), {
      id,
      projectId,
      name: "T",
      defaultNamePrefix: "T",
      now,
    });
    assert(result.kind === "applied");
    return id;
  }
  async function previousWorkerAccept(patternId: string) {
    const jobId = crypto.randomUUID(),
      messageId = crypto.randomUUID();
    const request = key("instruction.accept");
    const results = await db.raw.batch<{ result: string }>([
      db.raw
        .prepare(
          `INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at)
          SELECT ?, p.id, p.owner_id,
            (SELECT coalesce(max(m.number), 0) + 1 FROM messages m WHERE m.pattern_id = p.id),
            ?, ? FROM patterns p WHERE p.id = ? AND p.owner_id = ?`,
        )
        .bind(messageId, "fixture", now, patternId, ownerId),
      db.raw
        .prepare(
          `UPDATE jobs SET holds_queue = 0 WHERE pattern_id = ? AND owner_id = ? AND holds_queue = 1
    AND NOT EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = jobs.pattern_id AND q.state = 'queued')`,
        )
        .bind(patternId, ownerId),
      db.raw
        .prepare(
          `INSERT INTO jobs
          (id, pattern_id, owner_id, message_id, state, generation, base_revision_id, created_at, updated_at)
          SELECT ?, m.pattern_id, m.owner_id, m.id, 'queued', 0, NULL, ?, ?
          FROM messages m WHERE m.id = ? AND m.pattern_id = ? AND m.owner_id = ?`,
        )
        .bind(jobId, now, now, messageId, patternId, ownerId),
      db.raw
        .prepare(
          `INSERT INTO requests (owner_id, request_id, operation, fingerprint, result, created_at)
       SELECT ?, ?, ?, ?, (SELECT json_object('message', json_object('id', m.id, 'patternId', m.pattern_id,
    'number', m.number, 'body', m.body, 'createdAt', m.created_at),
        'job', json_object('id', j.id, 'patternId', j.pattern_id, 'messageId', j.message_id,
          'state', j.state, 'generation', j.generation, 'baseRevisionId', j.base_revision_id,
          'createdAt', j.created_at, 'updatedAt', j.updated_at))
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?), ?
       WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND owner_id = ?)
       RETURNING result`,
        )
        .bind(
          ownerId,
          request.requestId,
          request.operation,
          request.fingerprint,
          jobId,
          ownerId,
          now,
          jobId,
          ownerId,
        ),
    ]);
    const stored = results.at(-1)?.results[0]?.["result"];
    assert(typeof stored === "string");
    return { jobId, request, stored };
  }
  async function previousWorkerStop(jobId: string) {
    const request = key("job.stop");
    await db.raw.batch([
      db.raw
        .prepare(
          `INSERT INTO requests (owner_id, request_id, operation, fingerprint, result, created_at)
       SELECT ?, ?, ?, ?, (SELECT json_object('outcome', CASE WHEN j.state IN ('queued', 'running', 'validating', 'committing')
          THEN 'stopped' ELSE 'already_finished' END,
        'patternId', j.pattern_id, 'job', json_object('jobId', j.id, 'messageId', m.id, 'number', m.number,
    'state', CASE WHEN j.state IN ('queued', 'running', 'validating', 'committing') THEN 'cancelled' ELSE j.state END,
    'revision', CASE WHEN r.id IS NULL THEN NULL ELSE json_object('id', r.id, 'patternId', r.pattern_id,
    'number', r.number, 'name', r.name,
    'baseRevisionId', r.base_revision_id, 'createdAt', r.created_at) END))
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        LEFT JOIN revisions r ON r.job_id = j.id AND r.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?), ?
       WHERE EXISTS (SELECT 1 FROM jobs WHERE (id = ? AND owner_id = ? AND state IN ('queued', 'running', 'validating', 'committing', 'completed', 'cancelled', 'failed')))
       RETURNING result`,
        )
        .bind(
          ownerId,
          request.requestId,
          request.operation,
          request.fingerprint,
          jobId,
          ownerId,
          now,
          jobId,
          ownerId,
        ),
      db.raw
        .prepare(
          `UPDATE jobs SET holds_queue = 0 WHERE (holds_queue = 1 AND pattern_id = (SELECT s.pattern_id FROM jobs s
      WHERE s.id = ? AND s.owner_id = ? AND s.state = 'queued')
      AND NOT EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = jobs.pattern_id AND q.state = 'queued' AND q.id <> ?))
          AND EXISTS (SELECT 1 FROM jobs WHERE (id = ? AND owner_id = ? AND state IN ('queued', 'running', 'validating', 'committing', 'completed', 'cancelled', 'failed'))) AND EXISTS (SELECT 1 FROM requests
            WHERE owner_id = ? AND request_id = ? AND operation = ? AND fingerprint = ?)`,
        )
        .bind(
          jobId,
          ownerId,
          jobId,
          jobId,
          ownerId,
          ownerId,
          request.requestId,
          request.operation,
          request.fingerprint,
        ),
      db.raw
        .prepare(
          `UPDATE jobs SET state = CASE WHEN state IN ('queued', 'running', 'validating', 'committing') THEN 'cancelled' ELSE state END,
        updated_at = CASE WHEN state IN ('queued', 'running', 'validating', 'committing') THEN ? ELSE updated_at END, holds_queue = CASE WHEN jobs.state IN ('running', 'validating', 'committing')
    AND EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = jobs.pattern_id AND q.state = 'queued')
    AND NOT EXISTS (SELECT 1 FROM jobs h WHERE h.pattern_id = jobs.pattern_id AND h.holds_queue = 1)
    THEN 1 ELSE jobs.holds_queue END
       WHERE (id = ? AND owner_id = ? AND state IN ('queued', 'running', 'validating', 'committing', 'completed', 'cancelled', 'failed')) AND EXISTS (SELECT 1 FROM requests
            WHERE owner_id = ? AND request_id = ? AND operation = ? AND fingerprint = ?)`,
        )
        .bind(
          now,
          jobId,
          ownerId,
          ownerId,
          request.requestId,
          request.operation,
          request.fingerprint,
        ),
    ]);
  }
  async function previousWorkerClaim(patternId: string, expectedJob: string) {
    assert.equal(
      await db.raw
        .prepare(
          `UPDATE jobs SET state = 'running', generation = generation + 1,
        base_revision_id = (SELECT r.id FROM revisions r
          WHERE r.pattern_id = jobs.pattern_id ORDER BY r.number DESC LIMIT 1), updated_at = ?
        WHERE pattern_id = ? AND state = 'queued'
          AND id = (SELECT q.id FROM jobs q JOIN messages m
            ON m.id = q.message_id AND m.pattern_id = q.pattern_id
            WHERE q.pattern_id = ? AND q.state = 'queued' ORDER BY m.number LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.pattern_id = ?
            AND a.state IN ('running', 'validating', 'committing'))
          AND NOT EXISTS (SELECT 1 FROM jobs h WHERE h.pattern_id = ? AND h.holds_queue = 1)
        RETURNING id AS jobId, pattern_id AS patternId, owner_id AS ownerId,
          generation, base_revision_id AS baseRevisionId`,
        )
        .bind(now, patternId, patternId, patternId, patternId)
        .first("jobId"),
      expectedJob,
    );
  }
  async function previousWorkerFail(patternId: string, jobId: string) {
    assert.equal(
      await db.raw
        .prepare(
          `UPDATE jobs SET state = 'failed', updated_at = ?, holds_queue = CASE WHEN jobs.state IN ('running', 'validating', 'committing')
    AND EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = jobs.pattern_id AND q.state = 'queued')
    AND NOT EXISTS (SELECT 1 FROM jobs h WHERE h.pattern_id = jobs.pattern_id AND h.holds_queue = 1)
    THEN 1 ELSE jobs.holds_queue END
      WHERE id = ? AND pattern_id = ? AND generation = ? AND base_revision_id IS ? AND owner_id = ?
        AND state IN ('running', 'validating', 'committing') RETURNING 1 AS found`,
        )
        .bind(now, jobId, patternId, 1, null, ownerId)
        .first("found"),
      1,
    );
  }
  const lastFinishedSql = `SELECT json_object('jobId', j.id, 'messageId', m.id, 'number', m.number,
    'state', j.state,
    'revision', CASE WHEN r.id IS NULL THEN NULL ELSE json_object('id', r.id, 'patternId', r.pattern_id,
    'number', r.number, 'name', r.name,
    'baseRevisionId', r.base_revision_id, 'createdAt', r.created_at) END) AS json
  FROM messages m CROSS JOIN jobs j ON j.message_id = m.id AND j.pattern_id = m.pattern_id
  LEFT JOIN revisions r ON r.job_id = j.id AND r.pattern_id = j.pattern_id
  WHERE m.pattern_id = ? AND m.owner_id = ? AND j.state IN ('completed', 'cancelled', 'failed')
  ORDER BY m.number DESC LIMIT 1`;
  async function previousWorkerCommit(patternId: string, jobId: string) {
    const snapshotId = crypto.randomUUID(),
      revisionId = crypto.randomUUID();
    await db.raw.batch([
      db.raw
        .prepare(
          `INSERT INTO snapshots
        (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
        SELECT ?, j.owner_id, ?, 'owners/' || j.owner_id || '/snapshots/' || ? || '/manifest.json', ?, ?
        FROM jobs j WHERE j.id = ? AND j.pattern_id = ? AND j.generation = ? AND j.base_revision_id IS ? AND j.owner_id = ? AND j.state = 'running' AND j.base_revision_id IS (SELECT r.id FROM revisions r WHERE r.pattern_id = j.pattern_id ORDER BY r.number DESC LIMIT 1)`,
        )
        .bind(snapshotId, 1, snapshotId, "a".repeat(64), now, jobId, patternId, 1, null, ownerId),
      db.raw
        .prepare(
          `INSERT INTO revisions
        (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at, job_id, conversation_number)
        SELECT ?, j.pattern_id, j.owner_id,
          (SELECT coalesce(max(r.number), 0) + 1 FROM revisions r WHERE r.pattern_id = j.pattern_id),
          ?, s.id, j.base_revision_id, ?, j.id, m.number
        FROM jobs j JOIN snapshots s ON s.id = ? AND s.owner_id = j.owner_id
          JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.pattern_id = ? AND j.generation = ? AND j.base_revision_id IS ? AND j.owner_id = ? AND j.state = 'running' AND j.base_revision_id IS (SELECT r.id FROM revisions r WHERE r.pattern_id = j.pattern_id ORDER BY r.number DESC LIMIT 1)`,
        )
        .bind(revisionId, "R", now, snapshotId, jobId, patternId, 1, null, ownerId),
      db.raw
        .prepare(
          `UPDATE jobs SET state = 'completed', updated_at = ?
        WHERE id = ? AND pattern_id = ? AND generation = ? AND state = 'running'
          AND base_revision_id IS ? AND owner_id = ?
          AND EXISTS (SELECT 1 FROM revisions r WHERE r.id = ?
            AND r.job_id = jobs.id AND r.base_revision_id IS jobs.base_revision_id)`,
        )
        .bind(now, jobId, patternId, 1, null, ownerId, revisionId),
    ]);
  }
  async function exercisePreviousWorker() {
    const heldPattern = await pattern();
    const held = await previousWorkerAccept(heldPattern);
    await previousWorkerAccept(heldPattern);
    await previousWorkerClaim(heldPattern, held.jobId);
    await previousWorkerFail(heldPattern, held.jobId);
    assert.equal(
      await db.raw
        .prepare("SELECT holds_queue FROM jobs WHERE id = ?")
        .bind(held.jobId)
        .first("holds_queue"),
      1,
    );
    const runningPattern = await pattern();
    const running = await previousWorkerAccept(runningPattern);
    await previousWorkerClaim(runningPattern, running.jobId);
    const committedPattern = await pattern();
    const committed = await previousWorkerAccept(committedPattern);
    await previousWorkerClaim(committedPattern, committed.jobId);
    await previousWorkerCommit(committedPattern, committed.jobId);
    const last = await db.raw
      .prepare(lastFinishedSql)
      .bind(committedPattern, ownerId)
      .first<string>("json");
    assert(last);
    assert.equal(z.object({ state: z.string() }).parse(JSON.parse(last)).state, "completed");
    const cancelled = await previousWorkerAccept(committedPattern);
    await previousWorkerStop(cancelled.jobId);
    assert.equal(
      await db.raw
        .prepare("SELECT state FROM jobs WHERE id = ?")
        .bind(cancelled.jobId)
        .first("state"),
      "cancelled",
    );
    return { committed, committedPattern };
  }
  const { committed, committedPattern } = await exercisePreviousWorker();
  const migration = await readFile(conversationMigration, "utf8");
  const schema = () =>
    db.raw.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  const jobStates = () =>
    db.raw.prepare("SELECT id, state, holds_queue FROM jobs ORDER BY id").all();
  const originalStates = await jobStates();
  const original = await schema();
  await assert.rejects(
    db.apply(migration + "\nUPDATE messages SET kind = 'invalid';"),
    /CHECK constraint failed: messages_kind/,
  );
  assert.deepEqual((await schema()).results, original.results);
  await db.apply(migration);
  assert.deepEqual((await jobStates()).results, originalStates.results);
  async function instructionsOnly() {
    assert.deepEqual(
      (await db.raw.prepare("SELECT DISTINCT kind, job_id, choices FROM messages").all()).results,
      [{ kind: "instruction", job_id: null, choices: null }],
    );
  }
  await instructionsOnly();
  const replay = await db.store.jobs.acceptOnce(committed.request, {
    id: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    patternId: committedPattern,
    body: "fixture",
    now,
  });
  const originalAcceptance = z
    .object({
      job: z.object({ id: z.uuid() }),
      message: z.object({ id: z.uuid(), number: z.int().positive() }),
    })
    .parse(JSON.parse(committed.stored));
  assert.deepEqual(replay, {
    kind: "replayed",
    result: {
      jobId: originalAcceptance.job.id,
      messageId: originalAcceptance.message.id,
      number: originalAcceptance.message.number,
    },
  });
  await exercisePreviousWorker();
  await instructionsOnly();
  let number = 100;
  const insert = (
    kind: string,
    job: string | null,
    choices: string | null,
    patternId = committedPattern,
  ) =>
    db.raw
      .prepare(
        `INSERT INTO messages (id,pattern_id,owner_id,number,body,created_at,kind,job_id,choices)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(crypto.randomUUID(), patternId, ownerId, ++number, "body", now, kind, job, choices)
      .run();
  const job = committed.jobId;
  for (const option of conversationMessageSchema.options) {
    const kind = option.shape.kind.value;
    await insert(
      kind,
      kind === "instruction" || kind === "answer" ? null : job,
      kind === "question" ? "[]" : null,
    );
  }
  await insert("notice", null, null);
  for (const [kind, id, choices] of [
    ["unknown", null, null],
    ["instruction", job, null],
    ["answer", job, null],
    ["explanation", null, null],
    ["question", null, "[]"],
    ["question", job, null],
    ["notice", job, "[]"],
    ["question", job, "{}"],
    ["question", job, "invalid"],
    ["question", job, JSON.stringify(["a".repeat(16384)])],
  ] as const)
    await assert.rejects(insert(kind, id, choices), /CHECK constraint failed/);
  await assert.rejects(
    insert("notice", crypto.randomUUID(), null),
    /FOREIGN KEY constraint failed/,
  );
  await assert.rejects(insert("notice", job, null, first), /FOREIGN KEY constraint failed/);
  assert.deepEqual((await db.raw.prepare("PRAGMA foreign_key_check").all()).results, []);
} finally {
  await db.dispose();
}

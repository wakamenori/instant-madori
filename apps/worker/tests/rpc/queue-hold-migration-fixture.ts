import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  openJobDatabase,
  jobMigration,
  questionMigration,
  queueHoldMigration,
  conversationMigration,
  now,
} from "./jobs-support.ts";

import { z } from "zod";
import { createOnceStatements, updateOnceStatements, runOnce } from "../../src/storage/requests.ts";
import { d1 } from "../../src/storage/d1.ts";
import { finishedJobJson } from "../../src/storage/revisions.ts";

// Keep the previous Worker's job writes fixed so deploy overlap is tested against its SQL.
const messageSql = `INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at)
          SELECT ?, p.id, p.owner_id,
            (SELECT coalesce(max(m.number), 0) + 1 FROM messages m WHERE m.pattern_id = p.id),
            ?, ? FROM patterns p WHERE p.id = ? AND p.owner_id = ?`;
const jobSql = `INSERT INTO jobs
          (id, pattern_id, owner_id, message_id, state, generation, base_revision_id, created_at, updated_at)
          SELECT ?, m.pattern_id, m.owner_id, m.id, 'queued', 0, NULL, ?, ?
          FROM messages m WHERE m.id = ? AND m.pattern_id = ? AND m.owner_id = ?`;
const claimSql = `UPDATE jobs SET state = 'running', generation = generation + 1,
        base_revision_id = (SELECT r.id FROM revisions r
          WHERE r.pattern_id = jobs.pattern_id ORDER BY r.number DESC LIMIT 1), updated_at = ?
        WHERE pattern_id = ? AND state = 'queued'
          AND id = (SELECT q.id FROM jobs q JOIN messages m
            ON m.id = q.message_id AND m.pattern_id = q.pattern_id
            WHERE q.pattern_id = ? AND q.state = 'queued' ORDER BY m.number LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.pattern_id = ?
            AND a.state IN ('running', 'validating', 'committing'))
        RETURNING id AS jobId, pattern_id AS patternId, owner_id AS ownerId,
          generation, base_revision_id AS baseRevisionId`;
const failureSql = `UPDATE jobs SET state = 'failed', updated_at = ?
      WHERE id = ? AND pattern_id = ? AND generation = ? AND base_revision_id IS ? AND owner_id = ?
        AND state IN ('running', 'validating', 'committing') RETURNING 1 AS found`;

const db = await openJobDatabase();
try {
  await db.apply(await readFile(jobMigration, "utf8"));
  const ownerId = await db.owner("migration");
  const key = (operation: string) => ({
    ownerId,
    operation,
    fingerprint: "fixture",
    requestId: crypto.randomUUID(),
  });
  const projectId = crypto.randomUUID();
  const patternId = crypto.randomUUID();
  const project = await db.store.projects.createOnce(key("project.create"), {
    id: projectId,
    name: "P",
    now,
    firstPattern: { id: patternId, name: "T", defaultNamePrefix: "T" },
  });
  assert(project.kind === "applied");
  async function accept(id: string) {
    const job = crypto.randomUUID();
    const message = crypto.randomUUID();
    const batch = createOnceStatements(key("instruction.accept"), now, {
      table: "jobs",
      id: job,
      statements: [
        { sql: messageSql, bindings: [message, "fixture", now, id, ownerId] },
        { sql: jobSql, bindings: [job, now, now, message, id, ownerId] },
      ],
      result: {
        sql: `SELECT json_object('message', json_object('id', m.id, 'patternId', m.pattern_id,
          'number', m.number, 'body', m.body, 'createdAt', m.created_at),
        'job', json_object('id', j.id, 'patternId', j.pattern_id, 'messageId', j.message_id,
          'state', j.state, 'generation', j.generation, 'baseRevisionId', j.base_revision_id,
          'createdAt', j.created_at, 'updatedAt', j.updated_at))
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?`,
        bindings: [job, ownerId],
      },
    });
    assert.equal(
      (await runOnce(d1(db.raw), z.object({ job: z.object({ id: z.literal(job) }) }), batch)).kind,
      "applied",
    );
    return job;
  }
  const claim = (id: string) => db.raw.prepare(claimSql).bind(now, id, id, id).first("jobId");
  const fail = (job: string, id: string) =>
    db.raw.prepare(failureSql).bind(now, job, id, 1, null, ownerId).first("found");
  async function oldStop(job: string) {
    const stoppableJobStates = "'queued', 'running', 'validating', 'committing'";
    const finishedJobStates = "'completed', 'cancelled', 'failed'";
    const batch = updateOnceStatements(key("job.stop"), now, {
      table: "jobs",
      set: {
        sql: `state = CASE WHEN state IN (${stoppableJobStates}) THEN 'cancelled' ELSE state END,
        updated_at = CASE WHEN state IN (${stoppableJobStates}) THEN ? ELSE updated_at END`,
        bindings: [now],
      },
      where: {
        sql: `id = ? AND owner_id = ? AND state IN (${stoppableJobStates}, ${finishedJobStates})`,
        bindings: [job, ownerId],
      },
      result: {
        sql: `SELECT json_object('outcome', CASE WHEN j.state IN (${stoppableJobStates})
          THEN 'stopped' ELSE 'already_finished' END,
        'patternId', j.pattern_id, 'job', ${finishedJobJson("j", "m", "r", {
          state: `CASE WHEN j.state IN (${stoppableJobStates}) THEN 'cancelled' ELSE j.state END`,
        })})
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        LEFT JOIN revisions r ON r.job_id = j.id AND r.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?`,
        bindings: [job, ownerId],
      },
    });
    assert.equal(
      (await runOnce(d1(db.raw), z.object({ outcome: z.literal("stopped") }), batch)).kind,
      "applied",
    );
    assert.equal(
      await db.raw.prepare("SELECT state FROM jobs WHERE id = ?").bind(job).first("state"),
      "cancelled",
    );
  }
  async function pattern() {
    const id = crypto.randomUUID();
    assert.equal(
      (
        await db.store.patterns.createOnce(key("pattern.create"), {
          id,
          projectId,
          name: "T",
          defaultNamePrefix: "T",
          now,
        })
      ).kind,
      "applied",
    );
    return id;
  }
  const runningPattern = await pattern();
  const running = await accept(runningPattern);
  assert.equal(await claim(runningPattern), running);
  const a = await accept(patternId);
  const b = await accept(patternId);
  const c = await accept(patternId);
  assert.equal(await claim(patternId), a);
  assert.equal(await fail(a, patternId), 1);
  await oldStop(c);
  await db.apply(await readFile(queueHoldMigration, "utf8"));
  await db.apply(await readFile(conversationMigration, "utf8"));
  await db.apply(await readFile(questionMigration, "utf8"));
  const migrated = await db.raw
    .prepare("SELECT id, state, holds_queue FROM jobs ORDER BY id")
    .all();
  assert.deepEqual(
    migrated.results,
    [
      { id: a, state: "failed", holds_queue: 0 },
      { id: b, state: "queued", holds_queue: 0 },
      { id: c, state: "cancelled", holds_queue: 0 },
      { id: running, state: "running", holds_queue: 0 },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  for (const id of [patternId, runningPattern])
    assert.equal((await db.store.revisions.state({ ownerId, patternId: id }))?.queueHold, null);
  const claimed = await db.store.jobs.claim({ patternId, now });
  assert(claimed.kind === "claimed");
  assert.equal(claimed.right.reference.jobId, b);
  const previous = await pattern();
  assert.equal(
    (
      await db.store.patterns.renameOnce(key("pattern.rename"), {
        patternId: previous,
        name: "renamed",
        expectedVersion: 1,
        now,
      })
    ).kind,
    "applied",
  );
  const first = await accept(previous);
  const second = await accept(previous);
  assert.equal(await claim(previous), first);
  await oldStop(second);
  assert.equal(await fail(first, previous), 1);
  assert.deepEqual((await db.raw.prepare("PRAGMA foreign_key_check").all()).results, []);
} finally {
  await db.dispose();
}

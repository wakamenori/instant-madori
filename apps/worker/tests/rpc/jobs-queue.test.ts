import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedJobSchema, finishedJobSchema } from "@madori/contracts";
import { messagePageSql } from "../../src/storage/messages.ts";
import { runningJobSql, queuedJobsSql, lastFinishedJobSql } from "../../src/storage/revisions.ts";
import { applyJobMigrations, now, openJobDatabase } from "./jobs-support.ts";

await test("State queue reads scale with queued jobs instead of completed history on D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const ownerId = await db.owner("queue-reader");
  const otherId = await db.owner("queue-other");
  const created = await db.store.projects.createOnce(
    {
      ownerId,
      requestId: crypto.randomUUID(),
      operation: "project.create",
      fingerprint: "fixture",
    },
    {
      id: crypto.randomUUID(),
      name: "P",
      now,
      firstPattern: { id: crypto.randomUUID(), name: "T", defaultNamePrefix: "T" },
    },
  );
  assert(created.kind === "applied");
  const patternId = created.result.pattern.id;
  const uuid = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;
  await db.raw.batch([
    db.raw
      .prepare(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 3030)
      INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at)
      SELECT ${uuid}, ?, ?, i, 'instruction', ? FROM s`,
      )
      .bind(patternId, ownerId, now),
    db.raw
      .prepare(
        `INSERT INTO jobs (id, pattern_id, owner_id, message_id, state, generation, created_at, updated_at)
      SELECT ${uuid}, m.pattern_id, m.owner_id, m.id, 'completed', 0, ?, ? FROM messages m
      WHERE m.pattern_id = ?`,
      )
      .bind(now, now, patternId),
  ]);
  const snapshotId = crypto.randomUUID();
  await db.raw
    .prepare(
      `INSERT INTO snapshots (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
    VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .bind(snapshotId, ownerId, "fixture-manifest", "a".repeat(64), now)
    .run();
  await db.raw
    .prepare(
      `INSERT INTO revisions
    (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at, job_id, conversation_number)
    SELECT ${uuid}, j.pattern_id, j.owner_id, m.number, 'R', ?, NULL, ?, j.id, m.number
    FROM jobs j JOIN messages m ON m.id = j.message_id WHERE j.pattern_id = ?`,
    )
    .bind(snapshotId, now, patternId)
    .run();
  const appendNotices = (offset: number, count: number) =>
    db.raw
      .prepare(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
     INSERT INTO messages (id, pattern_id, owner_id, number, kind, body, created_at, job_id)
     SELECT ${uuid}, j.pattern_id, j.owner_id, ? + i, 'notice', 'notice', ?, j.id
     FROM s CROSS JOIN jobs j WHERE j.message_id = (SELECT id FROM messages WHERE pattern_id = ? AND number = 1)`,
      )
      .bind(count, offset, now, patternId)
      .run();
  const pageReads = async (before: number | null) => {
    const page = await db.raw.prepare(messagePageSql).bind(patternId, ownerId, before, 51).all();
    assert.equal(page.results.length, 51);
    return page.meta.rows_read;
  };
  await appendNotices(3030, 100);
  const firstPageReads = await pageReads(null);
  await appendNotices(3130, 1000);
  assert.equal(await pageReads(null), firstPageReads);
  assert.equal(await pageReads(3100), firstPageReads);

  for (const finished of ["completed", "cancelled"] as const) {
    for (const analyzed of [false, true]) {
      if (analyzed) await db.raw.prepare("ANALYZE").run();
      for (const queued of [0, 3, 30]) {
        await db.raw
          .prepare(
            `UPDATE jobs SET state = CASE WHEN message_id IN
        (SELECT id FROM messages WHERE pattern_id = ? AND number > 3030 - ?)
        THEN 'queued' ELSE ? END, generation = CASE WHEN ? = 'completed' THEN 1 ELSE 0 END WHERE pattern_id = ?`,
          )
          .bind(patternId, queued, finished, finished, patternId)
          .run();
        const result = await db.raw
          .prepare(queuedJobsSql)
          .bind(patternId, ownerId)
          .all<{ json: string }>();
        assert(result.success);
        const jobs = result.results.map((row) => acceptedJobSchema.parse(JSON.parse(row.json)));
        assert.deepEqual(
          jobs.map((job) => job.number),
          Array.from({ length: queued }, (_, i) => 3031 - queued + i),
        );
        assert(
          result.meta.rows_read <= 4 * queued + 2,
          JSON.stringify({ analyzed, queued, rowsRead: result.meta.rows_read }),
        );
        const terminal = await db.raw
          .prepare(lastFinishedJobSql)
          .bind(patternId, ownerId)
          .all<{ json: string }>();
        assert(terminal.results[0]);
        const last = finishedJobSchema.parse(JSON.parse(terminal.results[0].json));
        assert.equal(last.number, 3030 - queued);
        assert.equal(last.state, finished);
        assert(
          terminal.meta.rows_read <= 3 * queued + 5,
          JSON.stringify({ analyzed, queued, finished, rowsRead: terminal.meta.rows_read }),
        );
        const terminalPlan = await db.raw
          .prepare(`EXPLAIN QUERY PLAN ${lastFinishedJobSql}`)
          .bind(patternId, ownerId)
          .all<{ detail: string }>();
        assert(
          terminalPlan.results.some(
            (row) => row.detail.includes("messages_inputs") && row.detail.includes("pattern_id=?"),
          ),
        );
        const state = await db.store.revisions.state({ ownerId, patternId });
        assert.deepEqual(state?.queuedJobs, jobs);
        assert.deepEqual(state?.lastFinishedJob, last);
        const plan = await db.raw
          .prepare(`EXPLAIN QUERY PLAN ${queuedJobsSql}`)
          .bind(patternId, ownerId)
          .all<{ detail: string }>();
        assert(plan.results.some((row) => row.detail.includes("jobs_queue")));
        for (const running of [false, true]) {
          await db.raw
            .prepare(
              "UPDATE jobs SET state = ? WHERE pattern_id = ? AND message_id = (SELECT id FROM messages WHERE pattern_id = ? AND number = 1)",
            )
            .bind(running ? "running" : finished, patternId, patternId)
            .run();
          const active = await db.raw
            .prepare(runningJobSql)
            .bind(patternId, ownerId)
            .all<{ json: string }>();
          assert(
            active.meta.rows_read <= (running ? 3 : 0),
            JSON.stringify({ analyzed, queued, running, rowsRead: active.meta.rows_read }),
          );
          const activePlan = await db.raw
            .prepare(`EXPLAIN QUERY PLAN ${runningJobSql}`)
            .bind(patternId, ownerId)
            .all<{ detail: string }>();
          assert(
            activePlan.results.some((row) => row.detail.includes("jobs_one_active_per_pattern")),
          );
          const activeState = await db.store.revisions.state({ ownerId, patternId });
          const expected = active.results[0];
          assert.equal(active.results.length, running ? 1 : 0);
          assert.deepEqual(
            activeState?.runningJob,
            expected ? acceptedJobSchema.parse(JSON.parse(expected.json)) : null,
          );
          assert.deepEqual(activeState?.queuedJobs, jobs);
          assert.equal(await db.store.revisions.state({ ownerId: otherId, patternId }), null);
          assert.deepEqual(
            (await db.raw.prepare(runningJobSql).bind(patternId, otherId).all()).results,
            [],
          );
        }
        console.info(JSON.stringify({ analyzed, queued, rowsRead: result.meta.rows_read }));
      }
    }
  }
  await db.raw
    .prepare("UPDATE jobs SET state = 'completed' WHERE pattern_id = ? AND state = 'running'")
    .bind(patternId)
    .run();
  await db.raw
    .prepare(
      "DELETE FROM revisions WHERE job_id IN (SELECT id FROM jobs WHERE pattern_id = ? AND state = 'queued')",
    )
    .bind(patternId)
    .run();
  const waiting = await db.store.revisions.state({ ownerId, patternId });
  assert(waiting?.queuedJobs[0]);
  const firstQueued = waiting.queuedJobs[0];
  const claim = await db.store.jobs.claim({ patternId, now });
  assert(claim.kind === "claimed");
  assert.equal(claim.right.reference.jobId, firstQueued.jobId);
  const claimedState = await db.store.revisions.state({ ownerId, patternId });
  assert.deepEqual(claimedState?.runningJob, firstQueued);
  assert.deepEqual(claimedState?.queuedJobs, waiting.queuedJobs.slice(1));
  assert.deepEqual(
    (await db.raw.prepare(queuedJobsSql).bind(patternId, otherId).all()).results,
    [],
  );
  assert.equal(await db.store.revisions.state({ ownerId: otherId, patternId }), null);
});

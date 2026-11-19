import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { acceptedJobSchema } from "@madori/contracts";
import { runningJobSql, queuedJobsSql } from "../../src/storage/revisions.ts";
import { jobMigration, now, openJobDatabase } from "./jobs-support.ts";

await test("State queue reads scale with queued jobs instead of completed history on D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await db.apply(await readFile(jobMigration, "utf8"));
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
  for (const analyzed of [false, true]) {
    if (analyzed) await db.raw.prepare("ANALYZE").run();
    for (const queued of [0, 3, 30]) {
      await db.raw
        .prepare(
          `UPDATE jobs SET state = CASE WHEN message_id IN
        (SELECT id FROM messages WHERE pattern_id = ? AND number > 3030 - ?)
        THEN 'queued' ELSE 'completed' END WHERE pattern_id = ?`,
        )
        .bind(patternId, queued, patternId)
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
      const state = await db.store.revisions.state({ ownerId, patternId });
      assert.deepEqual(state?.queuedJobs, jobs);
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
          .bind(running ? "running" : "completed", patternId, patternId)
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
  await db.raw
    .prepare("UPDATE jobs SET state = 'completed' WHERE pattern_id = ? AND state = 'running'")
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

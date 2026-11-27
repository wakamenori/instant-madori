import { legacySnapshot } from "./snapshot-support.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { completeJob } from "../../src/services/jobs.ts";
import { readJobExecutionRight } from "../../src/storage/job-execution.ts";
import { snapshotFormatVersions } from "../../src/storage/snapshots.ts";
import {
  openJobDatabase,
  applyAttachmentMigrations,
  snapshotPattern,
  now,
  jobMigration,
  questionMigration,
  queueHoldMigration,
  conversationMigration,
  aiAttemptsMigration,
  snapshotMigration,
} from "./jobs-support.ts";

const previousWorkerActive = `j.id = ? AND j.pattern_id = ? AND j.generation = ?
      AND j.base_revision_id IS ? AND j.owner_id = ? AND j.state = 'running'
      AND j.base_revision_id IS (SELECT r.id FROM revisions r
        WHERE r.pattern_id = j.pattern_id ORDER BY r.number DESC LIMIT 1)`;
const previousWorkerSnapshotSql = `INSERT INTO snapshots
        (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
        SELECT ?, j.owner_id, ?, 'owners/' || j.owner_id || '/snapshots/' || ? || '/manifest.json', ?, ?
        FROM jobs j WHERE ${previousWorkerActive}`;
const previousWorkerRevisionSql = `INSERT INTO revisions
        (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at, job_id, conversation_number)
        SELECT ?, j.pattern_id, j.owner_id,
          (SELECT coalesce(max(r.number), 0) + 1 FROM revisions r WHERE r.pattern_id = j.pattern_id),
          ?, s.id, j.base_revision_id, ?, j.id, m.number
        FROM jobs j JOIN snapshots s ON s.id = ? AND s.owner_id = j.owner_id
          JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE ${previousWorkerActive}`;
const previousWorkerJobSql = `UPDATE jobs SET state = 'completed', updated_at = ?
        WHERE id = ? AND pattern_id = ? AND generation = ? AND state = 'running'
          AND base_revision_id IS ? AND owner_id = ?
          AND EXISTS (SELECT 1 FROM revisions r WHERE r.id = ?
            AND r.job_id = jobs.id AND r.base_revision_id IS jobs.base_revision_id)`;

const db = await openJobDatabase();
try {
  for (const migration of [
    jobMigration,
    queueHoldMigration,
    conversationMigration,
    aiAttemptsMigration,
  ]) {
    await db.apply(await readFile(migration, "utf8"));
  }
  await applyAttachmentMigrations(db);
  await db.apply(await readFile(questionMigration, "utf8"));
  const pattern = await snapshotPattern(db);
  const { ownerId, patternId } = pattern;
  const history: { revisionId: string; display: Uint8Array<ArrayBuffer> }[] = [];
  async function commit(previousWorker: boolean) {
    const right = await pattern.claim();
    const { jobId, generation, baseRevisionId } = readJobExecutionRight(right);
    assert.equal(baseRevisionId, history.at(-1)?.revisionId ?? null);
    const display = new Uint8Array([history.length + 1]);
    const snapshot = await legacySnapshot(db.bucket, right, display, now);
    if (previousWorker) {
      const id = crypto.randomUUID();
      const bindings = [jobId, patternId, generation, baseRevisionId, ownerId];
      const batch = await db.raw.batch([
        db.raw
          .prepare(previousWorkerSnapshotSql)
          .bind(snapshot.id, 1, snapshot.id, snapshot.manifestSha256, now, ...bindings),
        db.raw.prepare(previousWorkerRevisionSql).bind(id, "plan", now, snapshot.id, ...bindings),
        db.raw.prepare(previousWorkerJobSql).bind(now, ...bindings, id),
      ]);
      assert.deepEqual(
        batch.map((result) => result.meta.changes),
        [1, 1, 1],
      );
      history.push({ revisionId: id, display });
    } else {
      const result = await completeJob(db, {
        right,
        snapshot,
        explanation: "fixture",
        name: "plan",
      });
      assert(result.kind === "committed");
      history.push({ revisionId: result.revision.id, display });
    }
  }
  await commit(false);
  await commit(false);
  await commit(true);
  const rows = async (table: "snapshots" | "revisions") =>
    (await db.raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  const snapshots = await rows("snapshots");
  const revisions = await rows("revisions");
  await db.apply(await readFile(snapshotMigration, "utf8"));
  assert.deepEqual(await rows("snapshots"), snapshots);
  assert.deepEqual(await rows("revisions"), revisions);
  assert.deepEqual((await db.raw.prepare("PRAGMA foreign_key_check").all()).results, []);
  await commit(true);
  for (const { revisionId, display } of history) {
    const opened = await db.store.snapshots.open(await pattern.snapshot(revisionId));
    assert.equal(opened.house, null);
    assert.deepEqual(await opened.display.read(), display);
  }
  const insert = (version: number) =>
    db.raw
      .prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), ownerId, version, crypto.randomUUID(), "a".repeat(64), now)
      .run();
  for (const version of snapshotFormatVersions) await insert(version);
  await assert.rejects(
    insert(Math.max(...snapshotFormatVersions) + 1),
    /CHECK constraint failed: snapshots_format_version/,
  );
  await assert.rejects(
    db.raw.prepare("DELETE FROM snapshots WHERE id IN (SELECT snapshot_id FROM revisions)").run(),
    /FOREIGN KEY constraint failed/,
  );
  await assert.rejects(
    db.raw
      .prepare(
        "INSERT INTO revisions (id,pattern_id,owner_id,number,name,snapshot_id,created_at) VALUES (?, ?, ?, 5, 'plan', 'missing', ?)",
      )
      .bind(crypto.randomUUID(), patternId, ownerId, now)
      .run(),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal(
    await db.raw.prepare("SELECT name FROM sqlite_master WHERE name='snapshots_v1'").first(),
    null,
  );
} finally {
  await db.dispose();
}

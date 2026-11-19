import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  acceptInstruction,
  claimNextJob,
  saveJobSnapshot,
  completeJob,
} from "../../src/services/jobs.ts";
import { openJobDatabase, jobMigration, now } from "./jobs-support.ts";

const db = await openJobDatabase();
try {
  const ownerId = await db.owner("migration");
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
  assert.equal(created.kind, "applied");
  if (created.kind !== "applied") throw new Error("No pattern");
  const patternId = created.result.pattern.id;
  async function commit(baseRevisionId: string | null) {
    const id = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    await db.raw.batch([
      db.raw
        .prepare(
          `INSERT INTO snapshots (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
        VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .bind(snapshotId, ownerId, crypto.randomUUID(), "a".repeat(64), now),
      db.raw
        .prepare(
          `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at)
        SELECT ?, ?, ?, coalesce(max(number), 0) + 1, 'R', ?, ?, ? FROM revisions WHERE pattern_id = ?`,
        )
        .bind(id, patternId, ownerId, snapshotId, baseRevisionId, now, patternId),
    ]);
    const history = await db.store.revisions.list({ ownerId, patternId, after: null, limit: 1 });
    const revision = history?.revisions[0];
    assert(revision);
    return revision;
  }
  const r1 = await commit(null);
  const r2 = await commit(r1.id);
  const r3 = await commit(r2.id);
  assert.deepEqual(
    (await db.store.revisions.list({ ownerId, patternId, after: null, limit: 10 }))?.revisions[0],
    r3,
  );
  const self = crypto.randomUUID();
  await db.raw
    .prepare(
      `INSERT INTO revisions
    (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at)
    SELECT ?, pattern_id, owner_id, 4, 'Self', snapshot_id, ?, created_at FROM revisions WHERE id = ?`,
    )
    .bind(self, self, r3.id)
    .run();
  const before = await db.raw.prepare("SELECT * FROM revisions ORDER BY number").all();
  const sql = await readFile(jobMigration, "utf8");
  await assert.rejects(
    db.apply(`${sql}\nINSERT INTO messages (id) VALUES (NULL);`),
    /NOT NULL constraint failed/,
  );
  assert.deepEqual(
    (await db.raw.prepare("SELECT * FROM revisions ORDER BY number").all()).results,
    before.results,
  );
  assert.deepEqual(
    (
      await db.raw
        .prepare("SELECT name FROM sqlite_schema WHERE name IN ('messages','jobs','revisions_new')")
        .all()
    ).results,
    [],
  );
  await db.apply(sql);
  const after = await db.raw.prepare("SELECT * FROM revisions ORDER BY number").all();
  assert.deepEqual(
    after.results,
    before.results.map((r) => ({
      ...r,
      base_is_null: r.base_revision_id === null ? 1 : 0,
      job_id: null,
      conversation_number: null,
    })),
  );
  assert.deepEqual((await db.raw.prepare("PRAGMA foreign_key_check").all()).results, []);
  const deps = { store: db.store, runtime: db.runtime, wakePattern: async () => {} };
  const accepted = await acceptInstruction(deps, {
    ownerId,
    patternId,
    requestId: crypto.randomUUID(),
    body: "R5",
  });
  assert.equal(accepted.kind, "accepted");
  const claimed = await claimNextJob(deps, { patternId });
  assert(claimed.kind === "claimed");
  const saved = await saveJobSnapshot(deps, { right: claimed.right, display: new Uint8Array([1]) });
  assert(saved.kind === "saved");
  const completed = await completeJob(deps, {
    right: claimed.right,
    snapshot: saved.snapshot,
    name: "R5",
  });
  assert(completed.kind === "committed");
  const r5 = completed.revision;
  assert.equal(r5.number, 5);
  assert.equal(r5.baseRevisionId, self);
  const state = await db.store.revisions.state({ ownerId, patternId });
  assert.deepEqual(state?.currentRevision, r5);
  const history = await db.store.revisions.list({ ownerId, patternId, after: null, limit: 10 });
  assert.deepEqual(
    history?.revisions.map((r) => r.id),
    [r5.id, self, r3.id, r2.id, r1.id],
  );
  assert.deepEqual((await db.raw.prepare("PRAGMA foreign_key_check").all()).results, []);
  console.log("Populated migration, rollback, and job-based Worker commit/read passed");
} finally {
  await db.dispose();
}

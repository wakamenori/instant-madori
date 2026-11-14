import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    const result = await db.store.revisions.commit({
      id: crypto.randomUUID(),
      patternId,
      name: "R",
      baseRevisionId,
      snapshot: {
        id: crypto.randomUUID(),
        ownerId,
        formatVersion: 1,
        manifestKey: crypto.randomUUID(),
        manifestSha256: "a".repeat(64),
        createdAt: now,
      },
    });
    assert.equal(result.kind, "committed");
    if (result.kind !== "committed") throw new Error("No revision");
    return result.revision;
  }
  const r1 = await commit(null);
  const r2 = await commit(r1.id);
  const r3 = await commit(r2.id);
  assert.deepEqual((await db.store.revisions.state({ ownerId, patternId }))?.currentRevision, r3);
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
  const r5 = await commit(self);
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
  console.log("Populated migration, rollback, and unchanged Worker commit/read passed");
} finally {
  await db.dispose();
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyJobMigrations, openJobDatabase, snapshotPattern } from "./jobs-support.ts";
import { jobWork } from "../../src/storage/job-work.ts";
import { r2 } from "../../src/storage/r2.ts";

await test("immutable job work selects the first successful write and verifies stored bytes", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const pattern = await snapshotPattern(db);
  const right = await pattern.claim();
  const work = db.store.work;
  const [a, b] = await Promise.all([
    work.keep(right, "rounds/1.json", "first"),
    work.keep(right, "rounds/1.json", "second"),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(await work.read(right, a.ref.path, a.ref.sha256), a);
  const { jobId, generation } = right.reference;
  const key = `owners/${pattern.ownerId}/jobs/${jobId}/g${generation}/rounds/1.json`;
  assert.deepEqual((await db.bucket.head(key))?.customMetadata, {
    jobId,
    generation: String(generation),
  });
  await assert.rejects(work.read(right, a.ref.path, "0".repeat(64)), /job work/u);
  await db.bucket.put(key, "replaced");
  await assert.rejects(work.read(right, a.ref.path), /job work/u);
  const failure = new Error("R2 unavailable");
  const unavailable = jobWork({
    ...r2(db.bucket),
    putNew() {
      return Promise.reject(failure);
    },
  });
  await assert.rejects(
    unavailable.keep(right, "rounds/2.json", "turn"),
    (error) => error === failure,
  );
});

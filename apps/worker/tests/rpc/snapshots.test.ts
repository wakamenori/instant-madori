import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { test } from "node:test";
import { displayContentType } from "@madori/contracts";
import { completeJob } from "../../src/services/jobs.ts";
import type { SnapshotFile } from "../../src/storage/snapshots.ts";
import { StorageCorruption } from "../../src/storage/rows.ts";
import { openJobDatabase, applyJobMigrations, snapshotPattern, now } from "./jobs-support.ts";

async function assertFile(file: SnapshotFile, contentType: string, bytes: Uint8Array) {
  assert.equal(file.contentType, contentType);
  assert.deepEqual(await file.read(), bytes);
}

const encode = (s: string) => new TextEncoder().encode(s).slice();
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (path: string) =>
  new Uint8Array(await readFile(new URL("../../../../" + path, import.meta.url)));
const display = await fixture("crates/display/tests/two-bodies.mdsp");
const house = {
  data: await fixture("crates/housing/tests/fixtures/two-rooms-before-modifiers.json"),
  floorPlans: [
    { storey: "x:s1", svg: encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>') },
    { storey: "x:s2", svg: encode('<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>') },
  ],
  checks: encode('{"violations":[]}'),
};
await test("Committed snapshot files on D1 and R2", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  const pattern = await snapshotPattern(db);
  const { ownerId, patternId } = pattern;
  async function commit(version: 1 | 2 = 2) {
    const right = await pattern.claim();
    const snapshot = await db.store.snapshots.write(right, {
      id: crypto.randomUUID(),
      now,
      display,
      ...(version === 2 ? { house } : {}),
    });
    const done = await completeJob(db, { right, snapshot, name: "plan" });
    assert(done.kind === "committed");
    const revisionId = done.revision.id;
    const row = await pattern.snapshot(revisionId);
    assert.equal(row.formatVersion, version);
    const prefix = `owners/${ownerId}/snapshots/${row.id}/`;
    return { row, revisionId, prefix };
  }
  async function manifestText(key: string) {
    const object = await db.bucket.get(key);
    assert(object);
    return object.text();
  }
  await t.test("house, display, ordered floor plans and checks round trip", async () => {
    const { row } = await commit();
    const opened = await db.store.snapshots.open(row);
    assert(opened.house);
    await assertFile(opened.display, displayContentType, display);
    await assertFile(opened.house.data, "application/json", house.data);
    assert.deepEqual(
      await Promise.all(
        opened.house.floorPlans.map(async (p) => {
          assert.equal(p.contentType, "image/svg+xml");
          return { storey: p.storey, svg: await p.read() };
        }),
      ),
      house.floorPlans,
    );
    await assertFile(opened.house.checks, "application/json", house.checks);
  });
  for (const target of [
    "manifest.json",
    "house.json",
    "display.mdsp",
    "floor-plans/1.svg",
    "checks.json",
  ]) {
    await t.test(`detects same-length replacement of ${target}`, async () => {
      const { row, prefix } = await commit();
      const key = prefix + target;
      const object = await db.bucket.get(key);
      assert(object);
      if (target === "manifest.json") {
        const text = await object.text();
        const reordered =
          text.replace('{"formatVersion":2,', "{").slice(0, -1) + ',"formatVersion":2}';
        assert.equal(reordered.length, text.length);
        assert.notEqual(reordered, text);
        await db.bucket.put(key, reordered);
        await assert.rejects(db.store.snapshots.open(row), StorageCorruption);
        return;
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await db.bucket.put(key, bytes);
      const opened = await db.store.snapshots.open(row);
      assert(opened.house);
      const files = [
        ["house.json", opened.house.data, house.data],
        ["display.mdsp", opened.display, display],
        ["checks.json", opened.house.checks, house.checks],
      ] as const;
      for (const [name, file, expected] of files) {
        if (name === target) await assert.rejects(file.read(), StorageCorruption);
        else assert.deepEqual(await file.read(), expected);
      }
      for (const [i, plan] of opened.house.floorPlans.entries()) {
        if (`floor-plans/${i}.svg` === target) await assert.rejects(plan.read(), StorageCorruption);
        else assert.deepEqual(await plan.read(), house.floorPlans[i]?.svg);
      }
    });
  }
  await t.test("missing file fails on read", async () => {
    const { row, prefix } = await commit();
    await db.bucket.delete(prefix + "checks.json");
    const opened = await db.store.snapshots.open(row);
    assert(opened.house);
    await assert.rejects(opened.house.checks.read(), StorageCorruption);
  });
  await t.test(
    "house key bound to another snapshot fails at open with a matching manifest hash",
    async () => {
      const other = await commit();
      const { row, prefix, revisionId } = await commit();
      const old = await manifestText(row.manifestKey);
      const changed = old.replace(prefix + "house.json", other.prefix + "house.json");
      assert.notEqual(changed, old);
      await db.bucket.put(row.manifestKey, changed);
      await db.raw
        .prepare("UPDATE snapshots SET manifest_sha256=? WHERE id=?")
        .bind(hash(changed), row.id)
        .run();
      await assert.rejects(
        db.store.snapshots.open(await pattern.snapshot(revisionId)),
        StorageCorruption,
      );
    },
  );
  await t.test("version disagreement fails at open", async () => {
    const { row, revisionId } = await commit();
    await db.raw.prepare("UPDATE snapshots SET format_version=1 WHERE id=?").bind(row.id).run();
    await assert.rejects(
      db.store.snapshots.open(await pattern.snapshot(revisionId)),
      StorageCorruption,
    );
  });
  await t.test("current and frozen display-only snapshots open", async () => {
    const current = await commit(1);
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const prefix = `owners/${ownerId}/snapshots/${id}/`;
    const manifest = (path: string) =>
      JSON.stringify({
        formatVersion: 1,
        display: {
          key: path + "display.mdsp",
          mediaType: displayContentType,
          bytes: display.byteLength,
          sha256: hash(display),
        },
      });
    assert.equal(await manifestText(current.row.manifestKey), manifest(current.prefix));
    await db.bucket.put(prefix + "display.mdsp", display);
    await db.bucket.put(prefix + "manifest.json", manifest(prefix));
    await db.raw.batch([
      db.raw
        .prepare("INSERT INTO snapshots VALUES (?, ?, 1, ?, ?, ?)")
        .bind(id, ownerId, prefix + "manifest.json", hash(manifest(prefix)), now),
      db.raw
        .prepare(
          "INSERT INTO revisions (id,pattern_id,owner_id,number,name,snapshot_id,created_at) SELECT ?, ?, ?, max(number)+1, 'v1', ?, ? FROM revisions WHERE pattern_id=?",
        )
        .bind(revisionId, patternId, ownerId, id, now, patternId),
    ]);
    for (const row of [current.row, await pattern.snapshot(revisionId)]) {
      const opened = await db.store.snapshots.open(row);
      assert.equal(opened.house, null);
      assert.deepEqual(await opened.display.read(), display);
    }
  });
  await t.test("duplicate storeys leave the snapshot prefix empty", async () => {
    const right = await pattern.claim();
    const id = crypto.randomUUID();
    await assert.rejects(
      db.store.snapshots.write(right, {
        id,
        now,
        display,
        house: { ...house, floorPlans: house.floorPlans.map((p) => ({ ...p, storey: "x:s1" })) },
      }),
      /duplicate storey/,
    );
    assert.deepEqual(
      (await db.bucket.list({ prefix: `owners/${ownerId}/snapshots/${id}/` })).objects,
      [],
    );
  });
});

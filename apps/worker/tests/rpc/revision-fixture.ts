import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";
import { commitRevision } from "../../src/services/revisions.ts";
import type { Runtime } from "../../src/services/deps.ts";
import { commitRevision as commitRow, getRevisionSnapshot } from "../../src/storage/revisions.ts";
import { readSnapshotDisplay, writeSnapshot } from "../../src/storage/snapshots.ts";
import { StorageCorruption } from "../../src/storage/rows.ts";

const input = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("commit"),
      ownerId: z.uuid(),
      otherId: z.uuid(),
      patternId: z.uuid(),
    }),
    z.object({
      kind: z.literal("damage"),
      ownerId: z.uuid(),
      revisionId: z.uuid(),
      target: z.enum(["display", "manifest"]),
      missing: z.boolean(),
    }),
  ])
  .parse(JSON.parse(process.argv[3] ?? ""));
const state = z.string().min(1).parse(process.argv[2]);
// getMiniflarePersistRoot takes a literal path; dev appends v3 to --persist-to.
// The HTTP harness has stopped its Worker before launching this process.
const proxy = await getPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(state, "v3") },
  remoteBindings: false,
});
try {
  const { DB: db, BLOBS: bucket } = proxy.env;
  if (input.kind === "damage") {
    const snapshot = await getRevisionSnapshot(db, input);
    assert(snapshot);
    const key =
      input.target === "manifest"
        ? snapshot.manifestKey
        : snapshot.manifestKey.replace(/manifest\.json$/, "display.mdsp");
    if (input.missing) await bucket.delete(key);
    else {
      const object = await bucket.get(key);
      assert(object);
      // Same length and still valid, but different bytes: only the hash comparison can catch it.
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (input.target === "manifest") {
        const { formatVersion, display } = z
          .object({ formatVersion: z.unknown(), display: z.unknown() })
          .parse(JSON.parse(new TextDecoder().decode(bytes)));
        const reordered = new TextEncoder().encode(JSON.stringify({ display, formatVersion }));
        assert.equal(reordered.byteLength, bytes.byteLength);
        assert.notDeepEqual(reordered, bytes);
        await bucket.put(key, reordered);
      } else {
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        await bucket.put(key, bytes);
      }
    }
    await assert.rejects(readSnapshotDisplay(bucket, snapshot), StorageCorruption);
    console.log(JSON.stringify({ ok: true }));
  } else {
    const firstDisplay = new Uint8Array(
      await readFile(
        new URL("../../../../crates/display/tests/fixtures/v1-two-bodies.mdsp", import.meta.url),
      ),
    );
    const display = new Uint8Array(
      await readFile(new URL("../../../../crates/display/tests/two-bodies.mdsp", import.meta.url)),
    );
    assert.notDeepEqual(display, firstDisplay);
    // The clock runs backwards, so ordering by created_at instead of number would show.
    let clock = Date.parse("2026-11-14T00:00:00.000Z");
    const runtime: Runtime = {
      now: () => new Date((clock -= 1000)).toISOString(),
      newId: () => crypto.randomUUID(),
      newTraceId: () => crypto.randomUUID(),
    };
    const deps = { db, bucket, runtime };
    const commit = (baseRevisionId: string | null, ownerId = input.ownerId, name = "案") =>
      commitRevision(deps, { ownerId, patternId: input.patternId, baseRevisionId, name, display });
    const count = async (table: "snapshots" | "revisions") =>
      db.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
    const first = await commitRevision(deps, {
      ownerId: input.ownerId,
      patternId: input.patternId,
      baseRevisionId: null,
      name: "初案",
      display: firstDisplay,
    });
    assert.equal(first.kind, "committed");
    if (first.kind !== "committed") throw new Error("No first revision");
    assert.equal(first.revision.number, 1);
    assert.equal(first.revision.baseRevisionId, null);
    const second = await commit(first.revision.id);
    assert.equal(second.kind, "committed");
    if (second.kind !== "committed") throw new Error("No second revision");
    assert.equal(second.revision.number, 2);
    assert.equal(second.revision.baseRevisionId, first.revision.id);
    const before = [await count("snapshots"), await count("revisions")];
    assert.deepEqual(await commit(first.revision.id), { kind: "base_mismatch" });
    assert.deepEqual(await commit(null), { kind: "base_mismatch" });
    assert.deepEqual(await commit(second.revision.id, input.otherId), { kind: "not_found" });
    assert.deepEqual([await count("snapshots"), await count("revisions")], before);
    const missing = await commitRevision(deps, {
      ownerId: input.ownerId,
      patternId: crypto.randomUUID(),
      baseRevisionId: null,
      name: "案",
      display,
    });
    assert.deepEqual(missing, { kind: "not_found" });
    const racers = await Promise.all([commit(second.revision.id), commit(second.revision.id)]);
    assert.equal(racers.filter((r) => r.kind === "committed").length, 1);
    assert.equal(racers.filter((r) => r.kind === "base_mismatch").length, 1);
    assert.equal(await count("snapshots"), 3);
    assert.equal(await count("revisions"), 3);
    const winner = racers.find((r) => r.kind === "committed");
    assert(winner?.kind === "committed");
    const revisions = [first.revision, second.revision, winner.revision];
    assert.equal(winner.revision.number, 3);
    let latest = winner.revision;
    while (latest.number < 52) {
      // Stored untrimmed, this name would be 101 characters and fail the CHECK constraint.
      const name = latest.number === 51 ? ` ${"a".repeat(100)}` : "案";
      const result = await commit(latest.id, input.ownerId, name);
      assert(result.kind === "committed");
      if (latest.number === 51) assert.equal(result.revision.name, "a".repeat(100));
      latest = result.revision;
      revisions.push(latest);
    }
    const snapshot = await getRevisionSnapshot(db, {
      ownerId: input.ownerId,
      revisionId: first.revision.id,
    });
    assert(snapshot);
    assert.deepEqual((await readSnapshotDisplay(bucket, snapshot)).bytes, firstDisplay);
    const originalDisplay = await bucket.get(
      snapshot.manifestKey.replace(/manifest\.json$/, "display.mdsp"),
    );
    assert(originalDisplay);
    const originalBytes = await originalDisplay.arrayBuffer();
    await assert.rejects(
      writeSnapshot(bucket, {
        id: snapshot.id,
        ownerId: input.ownerId,
        now: runtime.now(),
        display: new Uint8Array([1, 2]),
      }),
      /already exists/,
    );
    const unchanged = await bucket.get(originalDisplay.key);
    assert(unchanged);
    assert.deepEqual(await unchanged.arrayBuffer(), originalBytes);
    const counts = [await count("snapshots"), await count("revisions")];
    for (const name of ["", " ", "\u200b", "a\u0007"]) {
      assert.deepEqual(await commit(latest.id, input.ownerId, name), { kind: "invalid_name" });
    }
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    const fresh = () =>
      writeSnapshot(bucket, {
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        now: runtime.now(),
        display,
      });
    // A failing revision insert must also roll back its preceding snapshot insert.
    await assert.rejects(
      commitRow(db, {
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        patternId: input.patternId,
        name: "",
        baseRevisionId: latest.id,
        snapshot: await fresh(),
      }),
      /CHECK constraint failed/,
    );
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    const foreignSnapshot = await writeSnapshot(bucket, {
      id: crypto.randomUUID(),
      ownerId: input.otherId,
      now: runtime.now(),
      display,
    });
    await assert.rejects(
      commitRow(db, {
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        patternId: input.patternId,
        name: "案",
        baseRevisionId: latest.id,
        snapshot: foreignSnapshot,
      }),
      /another owner/,
    );
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    // An already stored snapshot skips the snapshot insert; the base must still hold.
    assert.deepEqual(
      await commitRow(db, {
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        patternId: input.patternId,
        name: "案",
        baseRevisionId: first.revision.id,
        snapshot,
      }),
      { kind: "not_committed" },
    );
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    console.log(JSON.stringify({ revisions }));
  }
} finally {
  await proxy.dispose();
}
